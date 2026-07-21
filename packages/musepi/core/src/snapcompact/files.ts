// ============================================================
// MusePi snapcompact — file operation lists (OMP computeFileLists port).
// ============================================================

import type { SnapFileOperations } from "./types.ts";

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isUrlSchemePath(path: string): boolean {
	return URL_SCHEME_RE.test(path);
}

/** Split file ops into read-only vs modified, URL-scheme pseudo-paths out. */
export function computeFileLists(fileOps: SnapFileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written].filter((file) => !isUrlSchemePath(file)));
	const readFiles = [...fileOps.read].filter((file) => !isUrlSchemePath(file) && !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

const FILE_OPERATION_SUMMARY_LIMIT = 20;

/** One line per file with a ` (Read)` / ` (Write)` / ` (RW)` marker. */
export function formatFileList(
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	const mode = new Map<string, "Read" | "Write" | "RW">();
	for (const file of readFiles) mode.set(file, "Read");
	for (const file of modifiedFiles) mode.set(file, readSet?.has(file) ? "RW" : "Write");
	const all = [...mode.keys()].sort();
	const lines = all.slice(0, FILE_OPERATION_SUMMARY_LIMIT).map((file) => `${file} (${mode.get(file)})`);
	if (all.length > FILE_OPERATION_SUMMARY_LIMIT) {
		lines.push(`[…${all.length - FILE_OPERATION_SUMMARY_LIMIT} files elided…]`);
	}
	return lines.join("\n");
}

/** The FILES section of the summary (empty string when no files seen). */
export function formatFilesSection(readFiles: string[], modifiedFiles: string[], readSet?: ReadonlySet<string>): string {
	const files = formatFileList(readFiles, modifiedFiles, readSet);
	if (!files) return "";
	return `<files>\n${files}\n</files>`;
}
