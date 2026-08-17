// ============================================================
// Partition: which tools may be deferred, and the active-set math.
// ============================================================

import type { ToolEntry } from "./types.ts";

/** Sources that are never deferred: pi builtins and host-native (sdk) tools. */
export const NEVER_DEFERRED_SOURCES: readonly string[] = ["builtin", "sdk"];

export interface PartitionOptions {
	/** Extra tool names to force-defer regardless of source. */
	defer?: readonly string[];
	/** Tool names that must always stay loaded. */
	never?: readonly string[];
}

/** Host-reserved tool names that are never deferred. */
const NEVER_DEFERRED_TOOLS = new Set([
	"select_tools",
	"goal",
	"todo",
	"swarm",
	"task",
	"cron",
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob",
]);

/**
 * Tools that are always kept in the active set,
 * irrespective of source or partition options.
 */
const ALWAYS_ACTIVE = new Set(["select_tools", "read", "write", "edit", "bash", "grep", "glob", "find", "ls"]);

/**
 * Split tools into deferrable and always-active sets.
 *
 * Deferrable = extension-registered tools (any source other than the
 * never-deferred buckets) plus names forced via the `defer` config list,
 * minus the `never` list.
 */
export function partitionTools(
	entries: ToolEntry[],
	options: PartitionOptions = {},
): { deferrable: ToolEntry[]; active: ToolEntry[] } {
	const deferrable: ToolEntry[] = [];
	const active: ToolEntry[] = [];

	const neverSet = new Set([...NEVER_DEFERRED_TOOLS, ...(options.never ?? [])]);
	const deferSet = new Set(options.defer ?? []);

	for (const entry of entries) {
		// Always-active tools stay loaded
		if (ALWAYS_ACTIVE.has(entry.name)) {
			active.push(entry);
			continue;
		}

		// Tools explicitly forced to defer or from deferrable sources
		if (deferSet.has(entry.name) || (!NEVER_DEFERRED_SOURCES.includes(entry.source) && !neverSet.has(entry.name))) {
			deferrable.push(entry);
		} else {
			active.push(entry);
		}
	}

	return { deferrable, active };
}

/**
 * Compute the active set when tool-select is enabled.
 * Remove deferred names from the active set.
 */
export function activeNamesOnEnable(active: ToolEntry[], deferrable: ToolEntry[]): string[] {
	const deferrableNames = new Set(deferrable.map(e => e.name));
	return active.filter(e => !deferrableNames.has(e.name)).map(e => e.name);
}

/**
 * Compute the active set when tool-select is disabled.
 * All entries become active.
 */
export function activeNamesOnDisable(entries: ToolEntry[]): string[] {
	return entries.map(e => e.name);
}
