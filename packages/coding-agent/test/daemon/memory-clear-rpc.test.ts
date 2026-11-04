import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, removeWithRetries, setAgentDir } from "@musepi/pi-utils";
import { Settings } from "../../src/config/settings";
import { DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import type { DaemonConnection, LiveSession } from "../../src/daemon/session-host";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot, saveLearnedLesson } from "../../src/memories";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

/**
 * Real-RPC contract for `memory.clear` (TUI `/memory clear` parity):
 *
 * The route is not bound to a single session, so it must apply the
 * session-aware clear to every live session whose cwd matches the host cwd:
 * the backend clear drops that session's frozen developer-instructions
 * snapshot, and the session refreshes its base system prompt afterwards.
 * Sessions in other workspaces are untouched; with no matching live session
 * the route performs the allowed global clear.
 */

describe("daemon memory.clear RPC", () => {
	let tmp: string;
	let agentDir: string;
	let settings: Settings;
	let originalAgentDir: string;

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		tmp = `${os.tmpdir()}/omp-memory-clear-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		agentDir = path.join(tmp, "agent");
		setAgentDir(agentDir);
		settings = Settings.isolated({ "memory.backend": "local" });
	});
	afterEach(async () => {
		setAgentDir(originalAgentDir);
		await removeWithRetries(tmp);
	});

	function fakeAgentSession(
		sessionFile: string,
		hooks: { refresh: () => Promise<void> },
	): LiveSession["agentSession"] {
		return {
			sessionManager: { getSessionFile: () => sessionFile },
			refreshBaseSystemPrompt: hooks.refresh,
		} as unknown as LiveSession["agentSession"];
	}

	function harness(lives: LiveSession[]) {
		const host = {
			cwd: () => settings.getCwd(),
			settings: () => settings,
			get: () => undefined,
			allSessions: () => lives.values(),
			emitEvent: () => {},
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const conn = { id: "test" } as unknown as DaemonConnection;
		return (method: string, params?: Record<string, unknown>) => server.handle(method, params, conn);
	}

	it("invalidates the cached instructions and refreshes cwd-matching active sessions", async () => {
		const cwd = settings.getCwd();
		await Bun.write(path.join(getMemoryRoot(agentDir, cwd), "memory_summary.md"), "PRE_CLEAR_SUMMARY_MARKER\n");
		await saveLearnedLesson(agentDir, cwd, { content: "PRE_CLEAR_LESSON_MARKER" });

		const refreshCalls: string[] = [];
		const active = fakeAgentSession("session-active.jsonl", {
			refresh: async () => {
				refreshCalls.push("active");
			},
		});
		const elsewhere = fakeAgentSession("session-elsewhere.jsonl", {
			refresh: async () => {
				refreshCalls.push("elsewhere");
			},
		});

		// Freeze the per-session snapshot with pre-clear content.
		const frozen = await buildMemoryToolDeveloperInstructions(agentDir, settings, active);
		expect(frozen).toContain("PRE_CLEAR_LESSON_MARKER");

		const lives = [
			{ agentSession: active, cwd },
			{ agentSession: elsewhere, cwd: path.join(cwd, "elsewhere") },
		] as unknown as LiveSession[];
		const rpc = harness(lives);

		expect(await rpc("memory.clear")).toEqual({ ok: true });

		// The matching active session is refreshed exactly once; the
		// other-workspace session is untouched.
		expect(refreshCalls).toEqual(["active"]);

		// The frozen snapshot cache was invalidated: the rebuild reads the
		// wiped disk instead of resurrecting pre-clear content.
		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings, active)).toBeUndefined();
	});

	it("performs a global clear when no active session matches the cwd", async () => {
		const cwd = settings.getCwd();
		await Bun.write(path.join(getMemoryRoot(agentDir, cwd), "memory_summary.md"), "GLOBAL_CLEAR_SUMMARY_MARKER\n");

		const lives = [
			{
				agentSession: fakeAgentSession("session-detached.jsonl", { refresh: async () => {} }),
				cwd: path.join(cwd, "elsewhere"),
			},
		] as unknown as LiveSession[];
		const rpc = harness(lives);

		expect(await rpc("memory.clear")).toEqual({ ok: true });
		await expect(fs.access(getMemoryRoot(agentDir, cwd))).rejects.toThrow();
	});
});
