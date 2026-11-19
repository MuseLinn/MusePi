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
import { configuredWebOrigins, type LanShareUrls, LocalShareManager } from "@musepi/pi-coding-agent/collab/local-share";
import { resetSettingsForTest, Settings } from "@musepi/pi-coding-agent/config/settings";
import { initTheme } from "@musepi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@musepi/pi-coding-agent/modes/types";
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
	it("normalizes collab.webUrl into an origin and ignores empty or invalid values", async () => {
		settings.set("collab.webUrl", "https://web.example/collab");
		expect(configuredWebOrigins()).toEqual(["https://web.example"]);

		settings.set("collab.webUrl", "");
		expect(configuredWebOrigins()).toEqual([]);

		settings.set("collab.webUrl", "not a url");
		expect(configuredWebOrigins()).toEqual([]);
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
