/** Turn-tail presentation aggregation: the files a turn delivered via `present`. */
import { type PresentedFile, parsePresentedFiles } from "../../tool-render/presented.js";
import { isRecord } from "../../tool-render/util.js";

export type TurnPresentedBlocks = readonly {
	type: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}[];

/**
 * Files declared by the turn's successful `present` calls. Declarations are
 * turn-wide and cumulative; a duplicate path keeps the last description. The
 * card appears at the turn tail, so the `present` tool row stays one line.
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
