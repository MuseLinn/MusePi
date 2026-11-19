import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	BaseExposure,
	type ExposureCapabilities,
	type ExposureStartOptions,
	type ExposureStartResult,
	exposureRegistry,
} from "@musepi/pi-coding-agent/collab/exposure";
import { resetSettingsForTest, Settings, settings } from "@musepi/pi-coding-agent/config/settings";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/**
 * The exposure listing and the share lifecycle as a client sees it.
 *
 * The share record is authoritative (`hosting:false` once anything ends), and
 * the reason survives that clearing through `lastEnd` — a lost tunnel must
 * not read as "the share just vanished".
 */
class TestExposure extends BaseExposure {
	readonly id = "test-exposure";
	readonly label = "Test exposure";
	readonly capabilities: ExposureCapabilities = {
		guestInstall: false,
		publicExposure: true,
		stableUrl: false,
		thirdParty: false,
	};

	constructor() {
		super("test-exposure");
	}

	async probe() {
		this.setStatus({ id: this.id, health: "ready", detail: "test transport" });
		return this.status();
	}

	async start(options: ExposureStartOptions): Promise<ExposureStartResult> {
		const url = `ws://127.0.0.1:${options.port}`;
		this.setStatus({ id: this.id, health: "ready", url });
		// The browser link needs an http(s) origin; the host still connects over
		// the loopback ws URL, which is what the relay actually serves.
		return { joinUrl: url, webUrl: "https://test.example", webJoinUrl: "wss://test.example" };
	}

	degrade(detail: string): void {
		this.setStatus({
			id: this.id,
			health: "degraded",
			detail,
			hint: "Restart the share to get a new URL.",
		});
	}
}

interface StatusReply {
	hosting: boolean;
	mode?: string;
	sessionId?: string | null;
	exposure?: string;
	health?: { health: string; detail?: string; hint?: string } | null;
	lastEnd?: {
		exposure: string;
		health: string;
		at: string;
		reason: string;
		detail?: string;
		hint?: string;
	};
	link?: string;
}

let isolatedAgentDir: string;
let server: DaemonServer;
let lastExposure: TestExposure | null = null;
let releaseExposure: (() => void) | null = null;
let currentSessionId = "sess-1";
const sessionSubscribers: Array<(event: unknown) => void> = [];

const fakeSession = {
	sessionId: "sess-1",
	approvals: {
		pending: new Map<string, never>(),
		subscribe: () => () => {},
		resolve: () => false,
	},
	agentSession: {
		isStreaming: false,
		isAborting: false,
		queuedMessageCount: 0,
		sessionName: "test",
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => currentSessionId,
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({ header: { type: "session", id: currentSessionId }, entries: [] }),
			onEntryAppended: undefined,
		},
		subscribe: (cb: (event: unknown) => void) => {
			sessionSubscribers.push(cb);
			return () => {
				const index = sessionSubscribers.indexOf(cb);
				if (index >= 0) sessionSubscribers.splice(index, 1);
			};
		},
		emitNotice: () => {},
		abort: async () => {},
		promptCustomMessage: async () => {},
	},
	cwd: "/tmp",
};

const host = {
	cwd: () => process.cwd(),
	get: (sessionId: string) => (sessionId === "sess-1" ? fakeSession : undefined),
	activate: async (sessionId: string) => (sessionId === "sess-1" ? fakeSession : undefined),
	listWorkspaceSessions: async () => [],
	subscribeWorkspaceChanges: () => () => {},
	subscribe: async () => ({ seq: 0 }),
	touch: () => {},
	setCollabToolProvider: () => {},
	setScheduledTaskProvider: () => {},
	setOnExtensionNotification: () => {},
} as unknown as DaemonSessionHost;
const conn = { id: "c1" } as unknown as DaemonConnection;

function status(): Promise<StatusReply> {
	return server.handle("remote-access.status", {}, conn) as Promise<StatusReply>;
}

async function waitForStatus(predicate: (reply: StatusReply) => boolean, timeoutMs = 3_000): Promise<StatusReply> {
	const started = Date.now();
	for (;;) {
		const reply = await status();
		if (predicate(reply)) return reply;
		if (Date.now() - started > timeoutMs) throw new Error(`status condition not met; last: ${JSON.stringify(reply)}`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

async function startWorkspaceShare(): Promise<StatusReply> {
	const reply = (await server.handle(
		"collab.start",
		{ mode: "workspace", exposure: "test-exposure" },
		conn,
	)) as StatusReply;
	expect(reply.link).toBeTruthy();
	return await status();
}

beforeAll(async () => {
	isolatedAgentDir = await isolateAgentDirForTest("collab-exposure-rpc-");
	await Settings.init({ inMemory: true });
	server = new DaemonServer(host);
	releaseExposure = exposureRegistry.register("test-exposure", () => {
		lastExposure = new TestExposure();
		return lastExposure;
	});
}, 30_000);

afterAll(async () => {
	await server.handle("remote-access.stop", {}, conn).catch(() => {});
	settings.override("collab.shareTtlMinutes", 0);
	releaseExposure?.();
	resetSettingsForTest();
	await restoreAgentDirForTest(isolatedAgentDir);
}, 30_000);

describe("collab exposure RPC", () => {
	test("lists LAN plus every registered exposure with capabilities", async () => {
		const result = (await server.handle("collab.exposures", {}, conn)) as {
			default: string;
			exposures: Array<{
				id: string;
				health: string;
				label: string;
				capabilities: { guestInstall: boolean; publicExposure: boolean; stableUrl: boolean; thirdParty: boolean };
			}>;
		};
		expect(typeof result.default).toBe("string");
		const ids = result.exposures.map(entry => entry.id);
		expect(ids).toContain("lan");
		expect(ids).toContain("cloudflared");
		expect(ids).toContain("ngrok");
		expect(ids).toContain("tailscale");
		expect(ids).toContain("test-exposure");
		for (const entry of result.exposures) {
			expect(typeof entry.label).toBe("string");
			expect(["ready", "unavailable", "degraded"]).toContain(entry.health);
			expect(entry.capabilities).toEqual({
				guestInstall: expect.any(Boolean),
				publicExposure: expect.any(Boolean),
				stableUrl: expect.any(Boolean),
				thirdParty: expect.any(Boolean),
			});
		}
		const tailscale = result.exposures.find(entry => entry.id === "tailscale");
		expect(tailscale?.capabilities.guestInstall).toBe(true);
		const lan = result.exposures.find(entry => entry.id === "lan");
		expect(lan?.capabilities.publicExposure).toBe(false);
	});

	test("status without a share reports hosting: false", async () => {
		await expect(server.handle("remote-access.status", {}, conn)).resolves.toMatchObject({ hosting: false });
	});

	test("a session share without a session is refused before any transport starts", async () => {
		await expect(server.handle("collab.start", { mode: "session" }, conn)).rejects.toThrow(
			/open or create a session first/,
		);
		await expect(server.handle("collab.status", {}, conn)).resolves.toMatchObject({ hosting: false });
	});

	test("stopping the share records the end reason for the next status query", async () => {
		const live = await startWorkspaceShare();
		expect(live).toMatchObject({ hosting: true, mode: "workspace", exposure: "test-exposure" });
		expect(live.lastEnd).toBeUndefined();

		await server.handle("remote-access.stop", {}, conn);
		const ended = await status();
		expect(ended.hosting).toBe(false);
		expect(ended.lastEnd).toMatchObject({
			exposure: "test-exposure",
			health: "ready",
			reason: "stopped from gui",
		});
		expect(typeof ended.lastEnd?.at).toBe("string");
	});

	test("a degraded exposure ends the share and keeps detail + hint readable", async () => {
		await startWorkspaceShare();
		lastExposure!.degrade("edge node stopped answering");

		const ended = await waitForStatus(reply => reply.hosting === false);
		expect(ended.lastEnd).toMatchObject({
			exposure: "test-exposure",
			health: "degraded",
			reason: "exposure degraded",
			detail: "edge node stopped answering",
			hint: "Restart the share to get a new URL.",
		});
	});

	test("TTL expiry ends the share and says why", async () => {
		settings.override("collab.shareTtlMinutes", 0.01);
		try {
			await startWorkspaceShare();
			const ended = await waitForStatus(reply => reply.hosting === false, 5_000);
			expect(ended.lastEnd).toMatchObject({ reason: "share time limit reached" });
		} finally {
			settings.override("collab.shareTtlMinutes", 0);
		}
	});

	test("a session switch tears the host down and records the reason", async () => {
		const started = (await server.handle(
			"collab.start",
			{ mode: "session", sessionId: "sess-1", exposure: "test-exposure" },
			conn,
		)) as StatusReply;
		expect(started.mode).toBe("session");
		expect(started.sessionId).toBe("sess-1");

		currentSessionId = "sess-2";
		for (const subscriber of [...sessionSubscribers])
			subscriber({ type: "notice", level: "info", message: "switch" });

		const ended = await waitForStatus(reply => reply.hosting === false);
		expect(ended.lastEnd).toMatchObject({ reason: "session switched", exposure: "test-exposure" });
		currentSessionId = "sess-1";
	});

	test("starting a new share clears the previous end record", async () => {
		await startWorkspaceShare();
		await server.handle("remote-access.stop", {}, conn);
		expect((await status()).lastEnd?.reason).toBe("stopped from gui");

		const fresh = await startWorkspaceShare();
		expect(fresh.hosting).toBe(true);
		expect(fresh.lastEnd).toBeUndefined();
		await server.handle("remote-access.stop", {}, conn);
	});
});
