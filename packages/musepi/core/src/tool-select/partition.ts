// ============================================================
// Partition: which tools may be deferred, and the active-set math.
//
// Deferrable = extension-registered tools (any source other than the
// host-reserved "builtin"/"sdk" buckets) plus names forced via the
// `defer` config list, minus the `never` list (select_tools itself and
// the host's core interaction surface: goal/todo/swarm/task/cron).
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

export interface ToolPartition {
	alwaysLoaded: ToolEntry[];
	deferrable: ToolEntry[];
}

export function partitionTools(entries: readonly ToolEntry[], options: PartitionOptions = {}): ToolPartition {
	const defer = new Set(options.defer ?? []);
	const never = new Set(options.never ?? []);
	const alwaysLoaded: ToolEntry[] = [];
	const deferrable: ToolEntry[] = [];
	for (const entry of entries) {
		if (never.has(entry.name)) {
			alwaysLoaded.push(entry);
			continue;
		}
		const deferrableBySource = !NEVER_DEFERRED_SOURCES.includes(entry.source);
		if (deferrableBySource || defer.has(entry.name)) {
			deferrable.push(entry);
		} else {
			alwaysLoaded.push(entry);
		}
	}
	return { alwaysLoaded, deferrable };
}

/**
 * Active-set transition when the gate turns on: remove deferrable tools,
 * ensure select_tools is present. Order-preserving, deduped.
 */
export function activeNamesOnEnable(
	currentActive: readonly string[],
	deferrableNames: ReadonlySet<string>,
	selectToolsName: string,
): string[] {
	const out: string[] = [];
	for (const name of currentActive) {
		if (!deferrableNames.has(name) && name !== selectToolsName) out.push(name);
	}
	out.push(selectToolsName);
	return out;
}

/**
 * Active-set transition when the gate is off: make sure select_tools is
 * hidden (it is registered unconditionally so the gate can flip at runtime).
 */
export function activeNamesOnDisable(currentActive: readonly string[], selectToolsName: string): string[] {
	return currentActive.filter((name) => name !== selectToolsName);
}
