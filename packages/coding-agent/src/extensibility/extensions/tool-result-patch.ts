/**
 * One tool_result patch, applied in dispatch order. The listener returns only
 * its own modification; the dispatcher threads the accumulated event, so
 * later listeners see earlier changes (last write wins), which is what the
 * hand-written loop did and what Cordis serial must preserve.
 */
import type { ToolResultEvent, ToolResultEventResult } from "./types";

export function applyToolResultPatch(target: ToolResultEvent, patch: ToolResultEventResult | undefined): boolean {
	if (!patch) return false;
	let modified = false;
	if (patch.content !== undefined) {
		target.content = patch.content;
		modified = true;
	}
	if (patch.details !== undefined) {
		target.details = patch.details;
		modified = true;
	}
	if (patch.isError !== undefined) {
		target.isError = patch.isError;
		modified = true;
	}
	return modified;
}
