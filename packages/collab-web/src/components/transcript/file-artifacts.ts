/**
 * Turn-artifact extraction: which files did a tool call *produce*?
 *
 * ZCode-style file cards show only the final state of the files the agent
 * wrote — not every file it read or grepped. We therefore look at write-class
 * tools only, and dedupe by path keeping the LAST occurrence (a later write
 * supersedes an earlier one — the "final version").
 */
import { inputPaths } from "../../tool-render/tools/edit.js";
import { isRecord, str } from "../../tool-render/util.js";

const WRITE_TOOL_RE = /^(?:write|fs_write|fs-write|create)$/i;
const EDIT_TOOL_RE = /^(?:edit|apply_patch|patch|file_diff|diff|ast_edit)$/i;
const IMAGE_TOOL_RE = /^generate[_-]image$/i;

/** File paths produced by a single tool call (write/edit/patch families). */
export function artifactPaths(name: string, args: unknown): string[] {
	const n = name.toLowerCase();
	const a = isRecord(args) ? args : {};
	if (WRITE_TOOL_RE.test(n)) {
		const p = str(a.file_path ?? a.path ?? a.filePath);
		return p ? [p] : [];
	}
	if (EDIT_TOOL_RE.test(n)) {
		const content = str(a.content ?? a.patch ?? a.diff ?? a.replacement) ?? "";
		const paths = inputPaths(content);
		if (n === "ast_edit" && Array.isArray(a.paths)) {
			for (const p of a.paths) {
				if (typeof p === "string" && !paths.includes(p)) paths.push(p);
			}
		}
		return paths;
	}
	if (IMAGE_TOOL_RE.test(n)) {
		const p = str(a.path ?? a.file_path ?? a.output);
		return p ? [p] : [];
	}
	return [];
}

/** Map toolCall blocks → final artifact paths (deduped, last write wins). */
export function finalArtifacts(
	blocks: readonly { type: string; name?: string; arguments?: unknown }[],
	completed: (id: string) => boolean,
): { id: string; path: string }[] {
	// Preserve first-seen order while a later occurrence of the same path
	// replaces the earlier one (its block id too).
	const byPath = new Map<string, { id: string; path: string }>();
	for (const b of blocks) {
		if (b.type !== "toolCall" || typeof b.name !== "string") continue;
		const id = "id" in b && typeof b.id === "string" ? b.id : "";
		if (!id || !completed(id)) continue;
		for (const path of artifactPaths(b.name, b.arguments)) {
			byPath.set(path, { id, path });
		}
	}
	return [...byPath.values()];
}
