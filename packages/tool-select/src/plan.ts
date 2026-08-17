// ============================================================
// planLoad: three-way split of a select_tools request.
// ============================================================

import type { LoadPlan } from "./types.ts";

export interface PlanLoadOptions {
	/** Names allowed to be loaded (the deferrable universe). */
	deferrable: ReadonlySet<string>;
	/** Currently active tool names. */
	active: ReadonlySet<string>;
}

/**
 * Three-way split of a select_tools request:
 * - `toLoad`: deferrable, not yet active
 * - `alreadyAvailable`: already in the active set
 * - `unknown`: not in the deferrable universe
 */
export function planLoad(names: readonly string[], options: PlanLoadOptions): LoadPlan {
	const toLoad: string[] = [];
	const alreadyAvailable: string[] = [];
	const unknown: string[] = [];

	for (const name of names) {
		if (options.active.has(name)) {
			alreadyAvailable.push(name);
		} else if (options.deferrable.has(name)) {
			toLoad.push(name);
		} else {
			unknown.push(name);
		}
	}

	toLoad.sort();
	alreadyAvailable.sort();
	unknown.sort();

	return { toLoad, alreadyAvailable, unknown };
}
