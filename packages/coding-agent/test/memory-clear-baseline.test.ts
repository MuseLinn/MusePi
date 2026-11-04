import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	getMemoryRoot,
	refreshMemoryToolDeveloperInstructionsCacheAfterStartup,
	saveLearnedLesson,
} from "@musepi/pi-coding-agent/memories";
import { localBackend } from "@musepi/pi-coding-agent/memory-backend/local-backend";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@musepi/pi-utils";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

/**
 * Memory baseline must not resurrect after an explicit clear.
 *
 * The no-session instruction build seeds a per-root baseline snapshot that the
 * startup refresh merges forward into sessions whose per-session cache is
 * absent. `clearMemoryData` wipes the memory root on disk, so the baseline for
 * that root must be dropped too — otherwise the next startup refresh folds the
 * pre-clear lessons (and any stale summary semantics) back into the new
 * session's memory prompt.
 */
describe("clear drops the by-root instruction baseline", () => {
	let tmp: string;
	let agentDir: string;
	let settings: Settings;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-clear-baseline-"));
		agentDir = path.join(tmp, "agent");
		settings = Settings.isolated({ "memory.backend": "local" });
	});
	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	function sessionWithFile(sessionFile: string) {
		return { sessionManager: { getSessionFile: () => sessionFile } };
	}

	it("startup refresh does not resurrect cleared lessons or summary", async () => {
		const cwd = settings.getCwd();
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await Bun.write(path.join(memoryRoot, "memory_summary.md"), "PRE_CLEAR_SUMMARY_MARKER\n");
		await saveLearnedLesson(agentDir, cwd, { content: "PRE_CLEAR_LESSON_MARKER" });

		// No-session build seeds the by-root baseline with both artifacts.
		const baseline = await buildMemoryToolDeveloperInstructions(agentDir, settings);
		expect(baseline).toContain("PRE_CLEAR_SUMMARY_MARKER");
		expect(baseline).toContain("PRE_CLEAR_LESSON_MARKER");

		// Authoritative clear through the production backend path.
		const clearingSession = sessionWithFile("session-clear.jsonl");
		await localBackend.clear(agentDir, cwd, clearingSession as unknown as AgentSession);

		// A new session starts with no per-session cache; the startup refresh
		// must not fold the pre-clear baseline back into its snapshot.
		const freshSession = sessionWithFile("session-after-clear.jsonl");
		await refreshMemoryToolDeveloperInstructionsCacheAfterStartup(freshSession, agentDir, settings);

		const out = await buildMemoryToolDeveloperInstructions(agentDir, settings, freshSession);
		// The memory root was wiped: no summary, no lessons — nothing injects,
		// and neither the cleared lesson nor the old summary may resurrect.
		expect(out).toBeUndefined();
	});
});
