/** Turn-tail presentation aggregation: the files a turn delivered via `present`. */
import {
	PRESENTED_DELIVERABLES_TYPE,
	type PresentedFile,
	parsePresentedFiles,
	presentedFilesFromEntry,
} from "../../tool-render/presented.js";
import { isRecord } from "../../tool-render/util.js";

export type TurnPresentedBlocks = readonly {
	type: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}[];

/**
 * Files declared by the turn's successful `present` calls. This reads tool
 * results, so it covers transcripts recorded before `present` journaled its
 * declaration; a transcript with `deliverables/presented` entries uses those
 * instead (see {@link presentedEntryFiles}). The card appears at the turn tail,
 * so the `present` tool row stays one line.
 */
export function collectTurnPresented(
	blocks: TurnPresentedBlocks,
	resultOf: (toolCallId: string) => { isError?: boolean; details?: unknown } | undefined,
): PresentedFile[] {
	const byPath = new Map<string, PresentedFile>();
	for (const block of blocks) {
		if (block.type !== "toolCall" || block.name !== "present") continue;
		const id = block.id ?? "";
		if (id === "") continue;
		const result = resultOf(id);
		if (result === undefined || result.isError === true) continue;
		const details = isRecord(result.details) ? result.details : null;
		const source =
			details && Array.isArray(details.files)
				? details.files
				: isRecord(block.arguments) && Array.isArray(block.arguments.files)
					? block.arguments.files
					: [];
		for (const file of parsePresentedFiles(source)) byPath.set(file.path, file);
	}
	return [...byPath.values()];
}

/**
 * Files declared by one durable `deliverables/presented` entry. Entries are the
 * authoritative declaration once the tool journals them; tool results remain
 * the fallback for transcripts recorded before that.
 */
export function presentedEntryFiles(entry: { type?: string; customType?: string; data?: unknown }): PresentedFile[] {
	if (entry.type !== "custom" || entry.customType !== PRESENTED_DELIVERABLES_TYPE) return [];
	return presentedFilesFromEntry(entry.data);
}

/** Turn-wide declarations: a duplicate path keeps its last description. */
export function mergePresentedFiles(files: Iterable<PresentedFile>): PresentedFile[] {
	const byPath = new Map<string, PresentedFile>();
	for (const file of files) byPath.set(file.path, file);
	return [...byPath.values()];
}
