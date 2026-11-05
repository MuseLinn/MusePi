/**
 * Turn "本轮修改文件" aggregation: the files a turn wrote and how much each
 * one changed.
 *
 * The file SET comes from `finalArtifacts` (the turn's write-class tool calls,
 * last write wins), so this card and the artifact chips never disagree about
 * which files the turn produced. Line counts come from the edit/apply_patch
 * result details — a plain `write` carries no diff, and the card says so
 * instead of inventing numbers.
 */
import { diffStats } from "../../tool-render/tools/edit.js";
import { isRecord, str } from "../../tool-render/util.js";
import { finalArtifacts } from "./file-artifacts.js";

export interface TurnFileChange {
	path: string;
	added: number;
	removed: number;
	/** The tool result carried a per-file diff; false → no line-by-line view. */
	hasDiff: boolean;
}

export type TurnFileBlocks = readonly { type: string; id?: string; name?: string; arguments?: unknown }[];

const DIFF_TOOLS = new Set(["edit", "apply_patch"]);

interface DiffRow {
	path: string;
	added: number;
	removed: number;
}

/** Per-file diff rows of one edit/apply_patch result: `details.perFileResults[]`
 *  for multi-file results, `details.path` + `details.diff` for single-file ones.
 *  Error results and erroring per-file entries contribute nothing. */
function diffRows(details: unknown): DiffRow[] {
	if (!isRecord(details)) return [];
	const perFile = Array.isArray(details.perFileResults) ? details.perFileResults : null;
	if (perFile !== null && perFile.length > 0) {
		const rows: DiffRow[] = [];
		for (const file of perFile) {
			if (!isRecord(file) || file.isError === true) continue;
			const diff = str(file.diff);
			if (diff === null) continue;
			const path = str(file.path) ?? "?";
			rows.push({ path, ...diffStats(diff) });
		}
		return rows;
	}
	const diff = str(details.diff);
	if (diff === null) return [];
	return [{ path: str(details.path) ?? "?", ...diffStats(diff) }];
}

export function collectTurnFiles(
	blocks: TurnFileBlocks,
	resultOf: (toolCallId: string) => { isError?: boolean; details?: unknown } | undefined,
): TurnFileChange[] {
	const stats = new Map<string, DiffRow>();
	for (const block of blocks) {
		if (block.type !== "toolCall" || block.name === undefined || !DIFF_TOOLS.has(block.name)) continue;
		const id = block.id ?? "";
		if (!id) continue;
		const result = resultOf(id);
		if (result === undefined || result.isError === true) continue;
		for (const row of diffRows(result.details)) {
			const seen = stats.get(row.path);
			if (seen === undefined) {
				stats.set(row.path, { ...row });
				continue;
			}
			seen.added += row.added;
			seen.removed += row.removed;
		}
	}
	const artifacts = finalArtifacts(blocks, id => {
		const result = resultOf(id);
		return result !== undefined && result.isError !== true;
	});
	return artifacts.map(artifact => {
		const row = stats.get(artifact.path);
		return {
			path: artifact.path,
			added: row?.added ?? 0,
			removed: row?.removed ?? 0,
			hasDiff: row !== undefined,
		};
	});
}

/** Turn-wide `+A −R` totals over the files that reported a diff. */
export function turnFileTotals(files: readonly TurnFileChange[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const file of files) {
		if (!file.hasDiff) continue;
		added += file.added;
		removed += file.removed;
	}
	return { added, removed };
}

/** `src/foo.tsx` → `foo.tsx`; the row keeps the full path in its title. */
export function fileBaseName(path: string): string {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return index >= 0 ? path.slice(index + 1) : path;
}
