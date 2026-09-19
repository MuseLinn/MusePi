import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryToolDeveloperInstructionsCache,
	getMemoryRoot,
} from "@musepi/pi-coding-agent/memories";
import { removeWithRetries } from "@musepi/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-instructions-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

/** Minimal stand-in for the session fields the memory cache actually reads. */
function stubSession(sessionFile: string | undefined, cwd = process.cwd()) {
	return { sessionManager: { getSessionFile: () => sessionFile, getCwd: () => cwd } };
}

/** Write a memory summary for `cwd` under `agentDir`'s memory store. */
async function seedSummary(agentDir: string, cwd: string, summary: string): Promise<void> {
	const root = getMemoryRoot(agentDir, cwd);
	await fs.mkdir(root, { recursive: true });
	await Bun.write(path.join(root, "memory_summary.md"), summary);
}

describe("buildMemoryToolDeveloperInstructions", () => {
	it("uses memory:// URLs and does not expose raw memory root paths", async () => {
		await withTempDir(async agentDir => {
			const settings = Settings.isolated({ "memories.enabled": true });
			const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
			await fs.mkdir(memoryRoot, { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "Use structured retries for flaky network calls.");

			const instructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);
			expect(instructions).toBeDefined();
			expect(instructions).toContain("memory://root/memory_summary.md");
			expect(instructions).toContain("memory://root/skills/<name>/SKILL.md");
			expect(instructions).not.toContain(memoryRoot);
		});
	});
});

// Issue #41: a session can be re-pointed at another workspace without its session
// file changing. Before the fix the per-session cache was validated on the session
// file alone, so the new workspace kept receiving the previous project's summary.
describe("issue #41 — the memory cache is invalidated by a workspace switch", () => {
	it("serves each project its own summary under the same session", async () => {
		await withTempDir(async agentDir => {
			const cwdA = path.join(agentDir, "proj-a");
			const cwdB = path.join(agentDir, "proj-b");
			await seedSummary(agentDir, cwdA, "Project A: redis pool max_size=50.");
			await seedSummary(agentDir, cwdB, "Project B: docker build needs HTTP_PROXY.");

			// Same session identity throughout — only the workspace changes.
			const session = stubSession("/sessions/shared.jsonl");
			const settings = Settings.isolated({ "memories.enabled": true });

			await settings.reloadForCwd(cwdA);
			const forA = await buildMemoryToolDeveloperInstructions(agentDir, settings, session);
			expect(forA).toContain("Project A: redis pool max_size=50.");
			expect(forA).not.toContain("HTTP_PROXY");

			await settings.reloadForCwd(cwdB);
			const forB = await buildMemoryToolDeveloperInstructions(agentDir, settings, session);
			expect(forB).toContain("Project B: docker build needs HTTP_PROXY.");
			expect(forB).not.toContain("max_size=50");
		});
	});

	it("does not leak a foreign project's summary into a brand-new workspace", async () => {
		await withTempDir(async agentDir => {
			const cwdA = path.join(agentDir, "proj-a");
			const emptyCwd = path.join(agentDir, "brand-new");
			await seedSummary(agentDir, cwdA, "Project A: internal gateway read_timeout=60s.");

			const session = stubSession("/sessions/new.jsonl");
			const settings = Settings.isolated({ "memories.enabled": true });

			await settings.reloadForCwd(cwdA);
			await buildMemoryToolDeveloperInstructions(agentDir, settings, session);

			// The new project has no memory of its own; it must get nothing rather
			// than inheriting Project A's rules.
			await settings.reloadForCwd(emptyCwd);
			const fresh = await buildMemoryToolDeveloperInstructions(agentDir, settings, session);
			expect(fresh ?? "").not.toContain("read_timeout=60s");
		});
	});

	it("still serves a cached value when the workspace is unchanged", async () => {
		await withTempDir(async agentDir => {
			const cwd = path.join(agentDir, "proj-a");
			await seedSummary(agentDir, cwd, "Original summary.");

			const session = stubSession("/sessions/same.jsonl");
			const settings = Settings.isolated({ "memories.enabled": true });
			await settings.reloadForCwd(cwd);

			const first = await buildMemoryToolDeveloperInstructions(agentDir, settings, session);
			expect(first).toContain("Original summary.");

			// Rewriting the file on disk must NOT be picked up while the cached
			// (session, root) pair is still valid — the cache still works.
			await seedSummary(agentDir, cwd, "Rewritten summary.");
			const second = await buildMemoryToolDeveloperInstructions(agentDir, settings, session);
			expect(second).toContain("Original summary.");
			expect(second).not.toContain("Rewritten summary.");
		});
	});

	it("clearMemoryToolDeveloperInstructionsCache forces a re-read", async () => {
		await withTempDir(async agentDir => {
			const cwd = path.join(agentDir, "proj-a");
			await seedSummary(agentDir, cwd, "Original summary.");

			const session = stubSession("/sessions/same.jsonl");
			const settings = Settings.isolated({ "memories.enabled": true });
			await settings.reloadForCwd(cwd);

			await buildMemoryToolDeveloperInstructions(agentDir, settings, session);
			await seedSummary(agentDir, cwd, "Rewritten summary.");

			clearMemoryToolDeveloperInstructionsCache(session);
			const after = await buildMemoryToolDeveloperInstructions(agentDir, settings, session);
			expect(after).toContain("Rewritten summary.");
		});
	});
});
