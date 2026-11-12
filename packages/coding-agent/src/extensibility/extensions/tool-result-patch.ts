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
	// A post-tool hook can reject the result it just observed. The execution is
	// over, so the only honest effect is an error result that names the reason —
	// the model must not consume the output as success.
	if (patch.block === true) {
		const reason = patch.reason?.trim() || "The tool result was rejected by a hook.";
		target.content = [{ type: "text", text: reason }];
		target.isError = true;
		modified = true;
		return modified;
	}
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
