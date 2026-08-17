// ============================================================
// Ledger: the loaded-tool set is folded from session history.
// ============================================================

import type { AddedToolsCarrier } from "./types.ts";

/**
 * Fold all loaded tool names from deferred-load markers in history.
 *
 * pi marks deferred-tool load points on the tool result that introduced
 * them (`ToolResultMessage.addedToolNames`). This folds them back into
 * a loaded set — resume/compaction self-heal by re-folding.
 */
export function foldLoadedToolNames(messages: readonly AddedToolsCarrier[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const name of message.addedToolNames ?? []) names.add(name);
	}
	return names;
}

/**
 * Reconcile the active set on resume: tools loaded in history but not
 * in the current active set should be re-added.
 */
export function reconcileResumedActiveNames(loadedNames: Set<string>, currentActive: string[]): string[] {
	const activeSet = new Set(currentActive);
	for (const name of loadedNames) {
		if (!activeSet.has(name)) {
			activeSet.add(name);
		}
	}
	return [...activeSet];
}
