import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as net from "node:net";
import {
	BaseExposure,
	type ExposureCapabilities,
	ExposureRegistry,
	type ExposureStartOptions,
	type ExposureStartResult,
} from "@musepi/pi-coding-agent/collab/exposure";
import { CollabHost } from "@musepi/pi-coding-agent/collab/host";
import {
	configuredWebOrigins,
	findLanIpv4,
	type LanShareUrls,
	LocalShareManager,
} from "@musepi/pi-coding-agent/collab/local-share";
import { resetSettingsForTest, Settings } from "@musepi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@musepi/pi-coding-agent/modes/types";
import { initTheme } from "@musepi/pi-coding-agent/render/theme/theme";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@musepi/pi-coding-agent/slash-commands/builtin-registry";

/**
 * Contract: a browser UI hosted on an origin other than the in-process relay
 * (`collab.webUrl`) must be able to open the WebSocket. The relay's same-origin
 * check otherwise 403s the upgrade, so every share that starts a relay has to
 * forward that origin. The TUI tunnel path has its own user-visible contract:
 * `collab.exposure` chooses the default transport and an inline provider on
 * `/collab tunnel` overrides it.
 */

let settings: Settings;

beforeAll(async () => {
	resetSettingsForTest();
	settings = await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	resetSettingsForTest();
});

class StubExposure extends BaseExposure {
	readonly id = "stub";
	readonly label = "Stub exposure";
	readonly capabilities: ExposureCapabilities = {
		guestInstall: false,
		publicExposure: true,
		stableUrl: true,
		thirdParty: false,
	};

	constructor() {
		super("stub");
	}

	async probe() {
		this.setStatus({ id: this.id, health: "ready" });
		return this.status();
	}

	async start(_options: ExposureStartOptions): Promise<ExposureStartResult> {
		this.setStatus({ id: this.id, health: "ready", url: "https://stub.example" });
		return { joinUrl: "wss://stub.example", webUrl: "https://stub.example", webJoinUrl: "wss://stub.example" };
	}
}

function stubRegistry(): ExposureRegistry {
	const registry = new ExposureRegistry();
	registry.register("stub", () => new StubExposure());
	return registry;
}

/** Send the WebSocket handshake and resolve its status line. */
function handshake(port: number, origin: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
			socket.write(
				[
					`GET /r/${"a".repeat(16)}?role=host HTTP/1.1`,
					`Host: 127.0.0.1:${port}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"Sec-WebSocket-Version: 13",
					`Origin: ${origin}`,
					"",
					"",
				].join("\r\n"),
			);
		});
		let settled = false;
		const finish = (line: string) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(line);
		};
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString("latin1");
			const end = buffer.indexOf("\r\n");
			if (end !== -1) finish(buffer.slice(0, end));
		});
		socket.on("error", reject);
		setTimeout(() => finish(buffer.split("\r\n")[0] ?? ""), 2_000).unref?.();
	});
}

describe("collab relay allowed origins", () => {
	it("accepts only http(s) web UI origins and rejects non-web schemes", () => {
		settings.set("collab.webUrl", "https://web.example/collab");
		expect(configuredWebOrigins()).toEqual(["https://web.example"]);

		// http is allowed where the web-link formatter allows it: local and
		// private hosts only.
		settings.set("collab.webUrl", "http://localhost:3000");
		expect(configuredWebOrigins()).toEqual(["http://localhost:3000"]);
		settings.set("collab.webUrl", "http://127.0.0.1:3000");
		expect(configuredWebOrigins()).toEqual(["http://127.0.0.1:3000"]);
		settings.set("collab.webUrl", "http://192.168.1.5:3000");
		expect(configuredWebOrigins()).toEqual(["http://192.168.1.5:3000"]);
		settings.set("collab.webUrl", "http://[::1]:3000");
		expect(configuredWebOrigins()).toEqual(["http://[::1]:3000"]);
		// Private-range boundaries: 172.16-31 and 100.64-127 are allowed.
		settings.set("collab.webUrl", "http://172.31.255.1");
		expect(configuredWebOrigins()).toEqual(["http://172.31.255.1"]);
		settings.set("collab.webUrl", "http://100.127.255.1");
		expect(configuredWebOrigins()).toEqual(["http://100.127.255.1"]);

		// A `null` origin must never reach the relay's allowlist.
		for (const invalid of [
			"file:///x",
			"data:text/html,x",
			"javascript:alert(1)",
			"blob:https://web.example/1234",
			"http://web.example",
			"http://172.32.0.1",
			"http://100.128.0.1",
		]) {
			settings.set("collab.webUrl", invalid);
			expect(configuredWebOrigins()).toEqual([]);
		}

		settings.set("collab.webUrl", "https://web.example/collab?x=1");
		expect(configuredWebOrigins()).toEqual([]);
		settings.set("collab.webUrl", "https://web.example/collab#frag");
		expect(configuredWebOrigins()).toEqual([]);

		settings.set("collab.webUrl", "");
		expect(configuredWebOrigins()).toEqual([]);
	});

	it("reports an unusable collab.webUrl instead of silently ignoring it", () => {
		const lines: string[] = [];
		settings.set("collab.webUrl", "file:///x");
		expect(configuredWebOrigins(line => lines.push(line))).toEqual([]);
		expect(lines[0]).toContain("collab.webUrl");
		expect(lines[0]).toContain("http:// or https://");

		settings.set("collab.webUrl", "not a url");
		lines.length = 0;
		expect(configuredWebOrigins(line => lines.push(line))).toEqual([]);
		expect(lines[0]).toContain("must be an http:// or https:// URL");
	});

	it("lets the configured web UI origin reach the in-process relay", async () => {
		settings.set("collab.webUrl", "https://web.example/collab");
		const manager = new LocalShareManager({ port: 0, registry: stubRegistry() });
		await manager.startExposure("stub", { verifyReachable: false });
		const port = manager.relay?.port;
		expect(port).toBeDefined();

		expect((await handshake(port!, "https://web.example")).startsWith("HTTP/1.1 101")).toBe(true);
		expect((await handshake(port!, "https://evil.example")).startsWith("HTTP/1.1 403")).toBe(true);

		await manager.stop();
	});

	it("forwards the unusable collab.webUrl warning through startExposure", async () => {
		settings.set("collab.webUrl", "file:///x");
		const lines: string[] = [];
		const manager = new LocalShareManager({
			port: 0,
			registry: stubRegistry(),
			onStatus: line => lines.push(line),
		});
		await manager.startExposure("stub", { verifyReachable: false });
		expect(lines.some(line => line.includes("collab.webUrl") && line.includes("http:// or https://"))).toBe(true);
		await manager.stop();
	});

	it.skipIf(!findLanIpv4())("forwards the unusable collab.webUrl warning through startLan", async () => {
		settings.set("collab.webUrl", "file:///x");
		const lines: string[] = [];
		const manager = new LocalShareManager({ port: 0, onStatus: line => lines.push(line) });
		try {
			await manager.startLan();
			expect(lines.some(line => line.includes("collab.webUrl") && line.includes("http:// or https://"))).toBe(true);
		} finally {
			await manager.stop();
		}
	});
});

function fakeShareUrls(): LanShareUrls {
	return {
		joinUrl: "wss://stub.example",
		webUrl: "https://stub.example",
		webJoinUrl: "wss://stub.example",
	};
}

function createRuntimeHarness() {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const present = vi.fn();
	const ctx = {
		editor: { setText },
		showStatus,
		showError,
		present,
		settings: { get: vi.fn(() => "") },
		sessionManager: { getSessionId: () => "sess-1" },
		session: { isStreaming: false, subscribe: vi.fn(() => () => {}) },
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		setText,
		showStatus,
		showError,
		present,
		runtime: { ctx } as BuiltinSlashCommandRuntime,
	};
}

function mockStartedHost(): void {
	vi.spyOn(CollabHost.prototype, "start").mockImplementation(function (this: CollabHost): Promise<void> {
		Object.defineProperties(this, {
			link: { value: "relay.example.com/r/full-control", configurable: true },
			viewLink: { value: "relay.example.com/r/read-only", configurable: true },
			webLink: { value: "https://stub.example/#started", configurable: true },
			webViewLink: { value: "https://stub.example/#started-view", configurable: true },
			participants: { value: [{ name: "host", role: "host" as const }], configurable: true },
		});
		return Promise.resolve();
	});
}

describe("/collab tunnel exposure", () => {
	it("uses collab.exposure when no provider is named inline", async () => {
		settings.set("collab.exposure", "tailscale");
		mockStartedHost();
		const startTunnel = vi.spyOn(LocalShareManager.prototype, "startTunnel").mockResolvedValue(fakeShareUrls());
		const harness = createRuntimeHarness();

		await executeBuiltinSlashCommand("/collab tunnel", harness.runtime);

		expect(startTunnel).toHaveBeenCalledWith("tailscale");
	});

	it("lets an inline provider override collab.exposure", async () => {
		settings.set("collab.exposure", "tailscale");
		mockStartedHost();
		const startTunnel = vi.spyOn(LocalShareManager.prototype, "startTunnel").mockResolvedValue(fakeShareUrls());
		const harness = createRuntimeHarness();

		await executeBuiltinSlashCommand("/collab tunnel ngrok", harness.runtime);

		expect(startTunnel).toHaveBeenCalledWith("ngrok");
	});
});

describe("/collab workspace tunnel exposure", () => {
	it("uses collab.exposure when no provider is named inline", async () => {
		settings.set("collab.exposure", "tailscale");
		mockStartedHost();
		const startTunnel = vi.spyOn(LocalShareManager.prototype, "startTunnel").mockResolvedValue(fakeShareUrls());
		const harness = createRuntimeHarness();

		await executeBuiltinSlashCommand("/collab workspace tunnel", harness.runtime);

		expect(startTunnel).toHaveBeenCalledWith("tailscale");
		expect(harness.ctx.collabHost).toBeInstanceOf(CollabHost);
	});

	it("accepts an inline provider inside the workspace scope", async () => {
		settings.set("collab.exposure", "tailscale");
		mockStartedHost();
		const startTunnel = vi.spyOn(LocalShareManager.prototype, "startTunnel").mockResolvedValue(fakeShareUrls());
		const harness = createRuntimeHarness();

		await executeBuiltinSlashCommand("/collab workspace tunnel ngrok", harness.runtime);

		expect(startTunnel).toHaveBeenCalledWith("ngrok");
		expect(harness.ctx.collabHost).toBeInstanceOf(CollabHost);
	});
});
