// ============================================================
// Ledger: the loaded-tool set is folded from session history.
//
// pi marks deferred-tool load points on the tool result that introduced
// them (`ToolResultMessage.addedToolNames`); the provider projection
// (`deferredToolsMode: "kimi"`) replays schemas at those points. There is
// deliberately no separate persisted ledger — resume/compaction self-heal
// by re-folding, same invariant as kimi-code's toolSelectService.
// ============================================================

import type { AddedToolsCarrier } from "./types.ts";

/** All tool names ever loaded via deferred-load markers in the history. */
export function foldLoadedToolNames(messages: readonly AddedToolsCarrier[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const name of message.addedToolNames ?? []) names.add(name);
	}
	return names;
}

/**
 * Resume reconciliation: the active tool set is not persisted, so a resumed
 * session starts from defaults. Re-activate deferrable tools that history
 * says were loaded, so calls right after resume keep working. Returns the
 * input unchanged when there is nothing to reconcile.
 */
export function reconcileResumedActiveNames(
	currentActive: readonly string[],
	deferrableNames: ReadonlySet<string>,
	loadedFromHistory: ReadonlySet<string>,
): string[] {
	const missing: string[] = [];
	const active = new Set(currentActive);
	for (const name of loadedFromHistory) {
		if (deferrableNames.has(name) && !active.has(name)) missing.push(name);
	}
	if (missing.length === 0) return [...currentActive];
	missing.sort((a, b) => a.localeCompare(b));
	return [...currentActive, ...missing];
}
