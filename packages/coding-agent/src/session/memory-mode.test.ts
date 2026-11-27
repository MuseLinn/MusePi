import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { memoryToolNamesForMode, normalizeMemoryMode, sessionMemoryPolicy } from "./memory-mode";
import { SessionManager } from "./session-manager";

describe("session memory modes", () => {
	test("persistent sessions retain existing memory behavior", () => {
		expect(normalizeMemoryMode(undefined)).toBe("persistent");
		expect(normalizeMemoryMode("unexpected")).toBe("persistent");
		expect(sessionMemoryPolicy("persistent")).toEqual({ read: true, write: true, goal: true });
	});

	test("incognito reads existing memories without learning or goals", () => {
		expect(sessionMemoryPolicy("incognito")).toEqual({ read: true, write: false, goal: false });
		expect(memoryToolNamesForMode("incognito")).toEqual(["recall", "reflect"]);
	});

	test("temporary sessions neither read nor write memories", () => {
		expect(sessionMemoryPolicy("temporary")).toEqual({ read: false, write: false, goal: false });
		expect(memoryToolNamesForMode("temporary")).toEqual([]);
	});

	test("persists the mode through a session file round trip", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-memory-mode-"));
		const sessionDir = path.join(cwd, "sessions");
		try {
			const manager = SessionManager.create(cwd, sessionDir);
			const file = await manager.newSession({ memoryMode: "incognito" });
			await manager.ensureOnDisk();
			await manager.close();
			expect(file).toBeDefined();
			const restored = await SessionManager.open(file!, sessionDir);
			expect(restored.getHeader()?.memoryMode).toBe("incognito");
			await restored.close();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
