// ============================================================
// Announcement + result rendering.
//
// The announcement is re-injected into the outgoing context view on every
// request while un-loaded deferrable tools remain (pi's transformContext
// seam does not persist messages, so the current list is simply restated —
// no fold-based diffing needed). Wording follows kimi-code's
// renderLoadableToolsAnnouncement so models trained on that convention
// recognize it.
// ============================================================

import type { LoadPlan } from "./types.ts";

/**
 * Render the loadable-tools announcement for the outgoing context view.
 * `loadable` must be the current deferrable-but-not-active names, sorted.
 */
export function renderLoadableToolsAnnouncement(loadable: readonly string[]): string {
	if (loadable.length === 0) return "";
	return [
		`<tools_added>\n${loadable.join("\n")}\n</tools_added>`,
		"These tools are available but not loaded. Call select_tools with exact names to load their full definitions before calling them. Calling an unloaded tool directly fails with 'not found'.",
	].join("\n\n");
}

/** Result text for a select_tools call (mirrors kimi's output format). */
export function renderLoadResult(plan: LoadPlan): { text: string; isError: boolean } {
	const lines: string[] = [];
	if (plan.toLoad.length > 0) lines.push(`Loaded: ${plan.toLoad.join(", ")}`);
	if (plan.alreadyAvailable.length > 0) lines.push(`Already available: ${plan.alreadyAvailable.join(", ")}`);
	for (const name of plan.unknown) {
		lines.push(`Unknown tool: ${name}. Pick from the latest announced tools list.`);
	}
	const isError = plan.toLoad.length === 0 && plan.alreadyAvailable.length === 0;
	return { text: lines.join("\n"), isError };
}

/** select_tools tool description (kimi-compatible phrasing). */
export const SELECT_TOOLS_DESCRIPTION =
	"Load one or more tools by name so you can call them. " +
	"All available tool names are listed in the <tools_added> announcements " +
	"in the conversation context. " +
	"Pass the exact name(s) you need; their full definitions become available immediately, " +
	"so you can call them directly in your next tool call.";
