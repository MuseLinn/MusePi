// ============================================================
// planLoad: three-way split of a select_tools request.
//
// Mirrors kimi-code's AgentToolSelectService.load: already-active tools
// report as alreadyAvailable, deferrable-but-inactive tools become
// toLoad (sorted for deterministic output), everything else is unknown.
// ============================================================

import type { LoadPlan } from "./types.ts";

export interface PlanLoadOptions {
	/** Names allowed to be loaded (the deferrable universe). */
	deferrable: ReadonlySet<string>;
	/** Currently active tool names. */
	active: ReadonlySet<string>;
}

export function planLoad(names: readonly string[], options: PlanLoadOptions): LoadPlan {
	const toLoad: string[] = [];
	const alreadyAvailable: string[] = [];
	const unknown: string[] = [];
	for (const name of new Set(names)) {
		if (options.active.has(name)) {
			alreadyAvailable.push(name);
		} else if (options.deferrable.has(name)) {
			toLoad.push(name);
		} else {
			unknown.push(name);
		}
	}
	toLoad.sort((a, b) => a.localeCompare(b));
	return { toLoad, alreadyAvailable, unknown };
}
