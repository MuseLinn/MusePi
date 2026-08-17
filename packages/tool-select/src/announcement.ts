// ============================================================
// Announcement + result rendering for progressive tool disclosure.
// ============================================================

import type { LoadPlan } from "./types.ts";

/** The select_tools tool name sent to the model. */
export const SELECT_TOOLS_TOOL_NAME = "select_tools";

/**
 * Tool description exposed to the model for select_tools (matches
 * kimi-code convention so models trained on it recognize the pattern).
 */
export const SELECT_TOOLS_DESCRIPTION =
	"Load a deferred tool by name so its schema becomes available for subsequent calls. " +
	"Pass an array of tool names you want to load.";

/**
 * Render the loadable-tools announcement for the outgoing context view.
 * `loadable` must be the current deferrable-but-not-active names, sorted.
 */
export function renderLoadableToolsAnnouncement(loadable: readonly string[]): string {
	if (loadable.length === 0) return "";
	return ["<tools_added>", ...loadable.map(name => `  <tool>${name}</tool>`), "</tools_added>"].join("\n");
}

/**
 * Render the load result for the model.
 */
export function renderLoadResult(plan: LoadPlan): string {
	const lines: string[] = [];
	if (plan.toLoad.length > 0) {
		lines.push(`Loaded: ${plan.toLoad.join(", ")}`);
	}
	if (plan.alreadyAvailable.length > 0) {
		lines.push(`Already available: ${plan.alreadyAvailable.join(", ")}`);
	}
	if (plan.unknown.length > 0) {
		lines.push(`Unknown: ${plan.unknown.join(", ")}`);
	}
	return lines.join("\n") || "No tools matched.";
}
