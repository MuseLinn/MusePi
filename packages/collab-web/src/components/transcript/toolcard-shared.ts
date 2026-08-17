import type { ToolKind } from "../../tool-render/types";

/** Tool names that always render as diffs (hashline / apply_patch families). */
const DIFF_TOOL_RE = /^(?:diff|file_diff|diff_file|apply_patch|patch|edit|ast_edit)$/;

/**
 * aicss-style rendering kind for a tool call, derived from the wire name and
 * the model intent. `read` with a diff/patch intent counts; so does any tool
 * whose intent asks for a diff. Unknown tools get `null` and keep the current
 * rendering — the treatments are strictly additive.
 */
export function toolKind(name: string, intent?: string): ToolKind | undefined {
	const n = name.toLowerCase();
	const i = intent?.toLowerCase() ?? "";
	if (DIFF_TOOL_RE.test(n) || /\b(?:diff|patch)\b/.test(i)) return "diff";
	if (/search|web/.test(n)) return "search";
	if (/image|img|draw/.test(n)) return "image";
	return undefined;
}
