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

/** Internal URL schemes resolve to virtual devices / resources, not
 *  filesystem paths (xd:// mounts execute mounted tools via read/write;
 *  skill://, agent://, … route elsewhere). Never file artifacts — the
 *  file card's preview/open actions would fail on them. Mirrors the
 *  scheme list in internal-urls/router.ts. */
const INTERNAL_URL_RE =
	/^(?:xd|skill|agent|artifact|memory|history|local|rule|omp|mcp|issue|pr|ssh|vault|security|file):\/\//i;

/** OS temp roots — throwaway by definition: the agent cleans these up, so
 *  a card would outlive its file (preview/open → ENOENT). macOS: /tmp
 *  (→ /private/tmp) and per-user /var/folders; Linux: /tmp; Windows:
 *  %TEMP% (C:\Users\…\AppData\Local\Temp, C:\Temp). */
const TMP_PATH_RE =
	/^(?:\/private\/tmp\/|\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|C:\\Users\\[^\\/]+\\AppData\\Local\\Temp\\|C:\\Temp\\|%TEMP%\\|%TMP%\\|TMPDIR)/i;

/** Paths that survive as durable file artifacts: real filesystem paths
 *  only, outside internal URL schemes and OS temp roots. */
function isArtifactPath(p: string): boolean {
	return !INTERNAL_URL_RE.test(p) && !TMP_PATH_RE.test(p);
}

/** File paths produced by a single tool call (write/edit/patch families). */
export function artifactPaths(name: string, args: unknown): string[] {
	const n = name.toLowerCase();
	const a = isRecord(args) ? args : {};
	if (WRITE_TOOL_RE.test(n)) {
		const p = str(a.file_path ?? a.path ?? a.filePath);
		return p && isArtifactPath(p) ? [p] : [];
	}
	if (EDIT_TOOL_RE.test(n)) {
		const content = str(a.content ?? a.patch ?? a.diff ?? a.replacement) ?? "";
		const paths = inputPaths(content);
		if (n === "ast_edit" && Array.isArray(a.paths)) {
			for (const p of a.paths) {
				if (typeof p === "string" && !paths.includes(p)) paths.push(p);
			}
		}
		return paths.filter(isArtifactPath);
	}
	if (IMAGE_TOOL_RE.test(n)) {
		const p = str(a.path ?? a.file_path ?? a.output);
		return p && isArtifactPath(p) ? [p] : [];
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
