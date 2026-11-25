import {
	buildMemoryToolDeveloperInstructions,
	clearGlobalMemoryData,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	getMemoryRoot,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged and stays project-scoped. On top of it, `save()` persists
 * `learn`-tool lessons to the project's `learned.md`, or to the cross-project
 * `_global/learned.md` when the caller passes `scope: "global"` and
 * `musemem.globalScope` allows it. Structured search is still unavailable.
 */
export const musememBackend: MemoryBackend = {
	id: "musemem",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, _cwd, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		// Drop the session's cached snapshot first, then wipe disk state;
		// clearMemoryData also drops the by-root baseline so the startup refresh
		// cannot resurrect cleared lessons into the next session.
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearMemoryData(agentDir, cwd);
	},
	async clearGlobal(agentDir, session) {
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearGlobalMemoryData(agentDir);
	},
	async enqueue(agentDir, cwd) {
		enqueueMemoryConsolidation(agentDir, cwd);
	},
	async save(context, input) {
		const result = await saveLearnedLesson(context.agentDir, context.cwd, input);
		// The injected instructions read `learned.md`; drop this session's cached
		// snapshot so the next prompt rebuild carries the new lesson instead of
		// the frozen one.
		clearMemoryToolDeveloperInstructionsCache(context.session);
		return result;
	},
	workspaceDir(agentDir, cwd) {
		return getMemoryRoot(agentDir, cwd);
	},
	async status() {
		return {
			backend: "musemem" as const,
			active: true,
			writable: true,
			searchable: false,
			message:
				"MuseMem is active: project summaries plus lessons from the `learn` tool, with an optional cross-project lessons file. Structured search is not available.",
		};
	},
};
