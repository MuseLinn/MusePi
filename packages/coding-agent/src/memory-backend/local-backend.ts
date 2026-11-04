import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged. On top of it, `save()` persists `learn`-tool lessons to
 * `learned.md` (so `status()` reports `writable: true`); structured search is
 * still unavailable.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		// Drop the session's cached snapshot first, then wipe disk state;
		// clearMemoryData also drops the by-root baseline so the startup refresh
		// cannot resurrect cleared lessons into the next session.
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearMemoryData(agentDir, cwd);
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
	async status() {
		return {
			backend: "local" as const,
			active: true,
			writable: true,
			searchable: false,
			message:
				"Local rollout-summary memory is active; lessons from the `learn` tool are saved to learned.md. Structured search is not available.",
		};
	},
};
