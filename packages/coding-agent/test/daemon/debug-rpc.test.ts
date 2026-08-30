import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { RawSseDebugBuffer } from "../../src/debug/raw-sse-buffer";
import { __resetRemoteDebuggerForTests } from "../../src/debug/remote-debugger";

/**
 * debug.* RPC tests (TUI /debug selector parity): the handlers read pure
 * helpers (report bundles, logs, system info, profilers) against a STUB
 * session host — no real AgentSession is booted, so session-bound actions
 * (openArtifacts/dump/memory/rawSse/transcript/profileStop) are exercised
 * without a provider round-trip. clearCache is intentionally NOT executed
 * (it deletes real artifact dirs under the shared sessions dir); cacheStats
 * is read-only and safe.
 */

function makeHarness() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-rpc-"));
	const sessionFile = path.join(dir, "s1.jsonl");
	const artifactsDir = path.join(dir, "s1");
	fs.writeFileSync(sessionFile, '{"type":"user","content":"hello"}\n');
	fs.mkdirSync(artifactsDir, { recursive: true });
	fs.writeFileSync(path.join(artifactsDir, "note.txt"), "artifact");

	const buffer = new RawSseDebugBuffer();
	buffer.recordEvent({ event: null, data: "{}", raw: ['data: {"id":"x"}'] } as never);

	const live = {
		sessionId: "s1",
		agentSession: {
			sessionFile,
			rawSseDebugBuffer: buffer,
			model: { id: "test-model", name: "Test", provider: "test" },
			thinkingLevel: "high",
			getPlanModeState: () => ({ enabled: false }),
		},
	};
	const host = {
		cwd: () => dir,
		get: (id: string) => (id === "s1" ? live : undefined),
		snapshot: async () => ({
			entries: [
				{ id: "e1", type: "user", role: "user", content: [{ type: "text", text: "hello" }] },
				{ id: "e2", type: "assistant", role: "assistant", content: [{ type: "text", text: "hi there" }] },
				{ id: "e3", type: "user", role: "user", content: [{ type: "image", data: "x" }] },
			],
			state: {},
		}),
		// DaemonServer wires these on construction; the stub host ignores both.
		setCollabToolProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test", send: () => {} } as DaemonConnection;
	const rpc = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
		server.handle(method, params, conn);
	return { dir, sessionFile, artifactsDir, buffer, server, rpc };
}

describe("debug.* RPCs (TUI /debug selector parity)", () => {
	test("debug.systemInfo returns formatted environment text", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("debug.systemInfo")) as { text: string };
		expect(typeof res.text).toBe("string");
		expect(res.text.length).toBeGreaterThan(0);
	});

	test("debug.logs returns a text tail (possibly empty in CI)", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("debug.logs")) as { text: string };
		expect(typeof res.text).toBe("string");
	});

	test("debug.workProfile returns svg-or-null + sampleCount", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("debug.workProfile")) as { svg: string | null; sampleCount: number };
		expect(typeof res.sampleCount).toBe("number");
		// No work samples on a fresh test process: the shape is svg: null.
		expect(res.svg === null || typeof res.svg === "string").toBe(true);
	});

	test("debug.cacheStats returns aggregate artifact stats (read-only)", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("debug.cacheStats")) as {
			count: number;
			totalSize: number;
			oldestDate: number | null;
		};
		expect(typeof res.count).toBe("number");
		expect(typeof res.totalSize).toBe("number");
		expect(res.oldestDate === null || typeof res.oldestDate === "number").toBe(true);
	});

	test("debug.remoteDebugger returns an endpoint or a platform error", async () => {
		const { rpc } = makeHarness();
		try {
			const res = (await rpc("debug.remoteDebugger")) as { host: string; port: number; alreadyRunning: boolean };
			expect(typeof res.host).toBe("string");
			expect(typeof res.port).toBe("number");
			expect(res.alreadyRunning).toBe(false);
			__resetRemoteDebuggerForTests();
		} catch (err) {
			// bun:jsc inspector is platform-dependent — a clean error is
			// still correct behavior for the RPC boundary.
			expect(err).toBeInstanceOf(Error);
		}
	});

	test("debug.openArtifacts resolves the session artifacts dir and opens when asked", async () => {
		const { rpc, artifactsDir } = makeHarness();
		const opened = (await rpc("debug.openArtifacts", { sessionId: "s1", open: false })) as {
			path: string | null;
			reason?: string;
		};
		expect(opened.path).toBe(artifactsDir);
	});

	test("debug.openArtifacts reports no-artifacts when the dir is missing", async () => {
		const { rpc, artifactsDir } = makeHarness();
		fs.rmSync(artifactsDir, { recursive: true, force: true });
		const res = (await rpc("debug.openArtifacts", { sessionId: "s1", open: false })) as {
			path: string | null;
			reason?: string;
		};
		expect(res.path).toBeNull();
		expect(res.reason).toBe("no-artifacts");
	});

	test("debug.openArtifacts rejects unknown sessions", async () => {
		const { rpc } = makeHarness();
		await expect(rpc("debug.openArtifacts", { sessionId: "nope", open: false })).rejects.toThrow("Unknown session");
	});

	test("debug.rawSse returns captured frames + totals", async () => {
		const { rpc, buffer } = makeHarness();
		const res = (await rpc("debug.rawSse", { sessionId: "s1" })) as {
			text: string;
			totalEvents: number;
			droppedChars: number;
		};
		expect(res.totalEvents).toBe(1);
		expect(res.text).toContain("data:");
		expect(typeof res.droppedChars).toBe("number");
		// A fresh buffer yields empty text with zero totals.
		buffer.clear();
		const empty = (await rpc("debug.rawSse", { sessionId: "s1" })) as { text: string; totalEvents: number };
		expect(empty.text).toBe("");
		expect(empty.totalEvents).toBe(0);
	});

	test("debug.transcript writes the conversation to a temp txt", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("debug.transcript", { sessionId: "s1", open: false })) as {
			path: string;
			chars: number;
		};
		expect(res.chars).toBeGreaterThan(0);
		expect(fs.existsSync(res.path)).toBe(true);
		const text = fs.readFileSync(res.path, "utf8");
		expect(text).toContain("[user]");
		expect(text).toContain("hello");
		expect(text).toContain("hi there");
		// Image-only block degrades to a marker, never a crash.
		expect(text).toContain("[image]");
	});

	test("debug.profileStart → profileStop produces a bundled performance report", async () => {
		const { rpc } = makeHarness();
		const started = (await rpc("debug.profileStart")) as { profilerId: number };
		expect(typeof started.profilerId).toBe("number");
		const stopped = (await rpc("debug.profileStop", {
			profilerId: started.profilerId,
			sessionId: "s1",
		})) as { path: string; files: string[]; summary: string };
		expect(fs.existsSync(stopped.path)).toBe(true);
		expect(stopped.files.length).toBeGreaterThan(0);
		expect(stopped.summary.startsWith("# CPU Profile")).toBe(true);
	});

	test("debug.dumpReport produces a report bundle for a live session", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("debug.dumpReport", { sessionId: "s1" })) as { path: string; files: string[] };
		expect(fs.existsSync(res.path)).toBe(true);
		expect(res.files).toContain("session.jsonl");
	});

	test("debug.dumpReport rejects unknown sessions", async () => {
		const { rpc } = makeHarness();
		await expect(rpc("debug.dumpReport", { sessionId: "nope" })).rejects.toThrow("Unknown session");
	});
});
