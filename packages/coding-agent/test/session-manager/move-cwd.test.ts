import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { getDefaultSessionDir, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";
import { resolvePath } from "../../src/utils/paths.ts";

const ASSISTANT_MESSAGE = {
	role: "assistant",
	content: [{ type: "text", text: "hi" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
} as const;

describe("SessionManager.moveCwd", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `move-cwd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		savedAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
	});

	afterEach(() => {
		if (savedAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = savedAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createFlushedSession(cwd: string, sessionDir?: string): SessionManager {
		const sm = SessionManager.create(cwd, sessionDir);
		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sm.appendMessage(ASSISTANT_MESSAGE as never);
		return sm;
	}

	it("is a no-op when the target equals the current cwd", () => {
		const sm = createFlushedSession(projectA);
		const fileBefore = sm.getSessionFile();
		const result = sm.moveCwd(projectA);
		expect(result.moved).toBe(false);
		expect(sm.getSessionFile()).toBe(fileBefore);
		expect(sm.getCwd()).toBe(resolvePath(projectA));
	});

	it("relocates the session file into the new cwd bucket and rewrites the header", () => {
		const sm = createFlushedSession(projectA);
		const oldFile = sm.getSessionFile()!;
		expect(oldFile.startsWith(getDefaultSessionDir(projectA))).toBe(true);
		expect(existsSync(oldFile)).toBe(true);

		const result = sm.moveCwd(projectB);

		expect(result.moved).toBe(true);
		expect(result.relocatedSessionFile).toBe(true);
		expect(sm.getCwd()).toBe(resolvePath(projectB));
		expect(sm.getSessionDir()).toBe(getDefaultSessionDir(projectB));
		expect(sm.usesDefaultSessionDir()).toBe(true);
		expect(existsSync(oldFile)).toBe(false);
		const newFile = sm.getSessionFile()!;
		expect(newFile.startsWith(getDefaultSessionDir(projectB))).toBe(true);
		expect(existsSync(newFile)).toBe(true);

		// Header on disk carries the new cwd; history is fully preserved.
		const entries = loadEntriesFromFile(newFile);
		const header = entries.find((e) => e.type === "session");
		expect(header).toMatchObject({ type: "session", cwd: resolvePath(projectB) });
		expect(entries.filter((e) => e.type === "message")).toHaveLength(2);

		// /resume from the destination project can open it.
		const reopened = SessionManager.open(newFile);
		expect(reopened.getCwd()).toBe(resolvePath(projectB));
		expect(reopened.getSessionId()).toBe(sm.getSessionId());
	});

	it("moves the per-session plan-state sidecar along with the session file", () => {
		const sm = createFlushedSession(projectA);
		const sidecar = join(sm.getSessionDir(), `.plan-state-${sm.getSessionId()}.json`);
		writeFileSync(sidecar, JSON.stringify({ isActive: true }));

		sm.moveCwd(projectB);

		expect(existsSync(sidecar)).toBe(false);
		expect(existsSync(join(sm.getSessionDir(), `.plan-state-${sm.getSessionId()}.json`))).toBe(true);
	});

	it("keeps lazy first-write semantics for an unflushed session", () => {
		const sm = SessionManager.create(projectA);
		const oldFile = sm.getSessionFile()!;
		expect(existsSync(oldFile)).toBe(false);

		const result = sm.moveCwd(projectB);

		expect(result.moved).toBe(true);
		expect(existsSync(oldFile)).toBe(false);
		const newFile = sm.getSessionFile()!;
		expect(newFile.startsWith(getDefaultSessionDir(projectB))).toBe(true);
		expect(existsSync(newFile)).toBe(false);

		// First flush lands in the new bucket.
		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sm.appendMessage(ASSISTANT_MESSAGE as never);
		expect(existsSync(newFile)).toBe(true);
		const header = loadEntriesFromFile(newFile).find((e) => e.type === "session");
		expect(header).toMatchObject({ cwd: resolvePath(projectB) });
	});

	it("keeps a custom session dir in place and only rewrites the header cwd", () => {
		const customDir = join(tempDir, "custom-sessions");
		const sm = createFlushedSession(projectA, customDir);
		const fileBefore = sm.getSessionFile()!;

		const result = sm.moveCwd(projectB);

		expect(result.moved).toBe(true);
		expect(result.relocatedSessionFile).toBe(false);
		expect(sm.getSessionDir()).toBe(resolvePath(customDir));
		expect(sm.getSessionFile()).toBe(fileBefore);
		expect(existsSync(fileBefore)).toBe(true);
		const header = loadEntriesFromFile(fileBefore).find((e) => e.type === "session");
		expect(header).toMatchObject({ cwd: resolvePath(projectB) });
	});

	it("throws when the target bucket already contains a conflicting session file", () => {
		const sm = createFlushedSession(projectA);
		const oldFile = sm.getSessionFile()!;
		const collision = join(getDefaultSessionDir(projectB), oldFile.split(/[\\/]/).pop()!);
		mkdirSync(getDefaultSessionDir(projectB), { recursive: true });
		writeFileSync(collision, "{}\n");

		expect(() => sm.moveCwd(projectB)).toThrow(/already exists/);
		// State and file are untouched.
		expect(sm.getCwd()).toBe(resolvePath(projectA));
		expect(existsSync(oldFile)).toBe(true);
	});

	it("updates cwd for an in-memory session without touching the filesystem", () => {
		const sm = SessionManager.inMemory(projectA);
		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		const result = sm.moveCwd(projectB);

		expect(result.moved).toBe(true);
		expect(result.relocatedSessionFile).toBe(false);
		expect(sm.getCwd()).toBe(resolvePath(projectB));
		expect(sm.getSessionFile()).toBeUndefined();
	});
});
