// ============================================================
// MusePi snapcompact — deterministic compaction driver.
//
// One pass: serialize discarded history → unfold the prior archive
// (or fall back to the previous LLM summary for continuity) → lay
// out edges + budgeted middle → emit a static summary with a short
// reading guide and the FILES section. No LLM call, deterministic:
// the same discarded history always compacts to the same summary.
// ============================================================

import {
	DEFAULT_ARCHIVE_MAX_CHARS,
	elisionNotice,
	estimateTokensFromChars,
	FRAME_CHAR_CAPACITY,
	planArchive,
} from "./archive.ts";
import { computeFileLists, formatFilesSection } from "./files.ts";
import { serializeConversation } from "./serialize.ts";
import type { SerializeOptions } from "./types.ts";
import type { SnapCompactionInput, SnapCompactionResult } from "./types.ts";

/** Engine version stamped onto persisted archive state. */
export const SNAP_ARCHIVE_VERSION = 1;

const READING_GUIDE = [
	"Reading guide for the archived history below:",
	"- ¶user: / ¶ai: / ¶think: mark user, assistant, and reasoning blocks.",
	"- ¶call: lines are tool calls as name(args)//intent; the <out> block under",
	"  a call holds its (truncated) tool result. […Nch elided…] marks middle cuts.",
	"- Numbered pages [archive N/M] are the oldest-to-newest middle history;",
	"  the verbatim head and tail edges carry the highest-fidelity context.",
	"- This archive is complete as of the cut point; current files on disk may",
	"  have changed since — verify against the repository before relying on it.",
].join("\n");

function leadIn(tokensBefore: number, archiveChars: number): string {
	return (
		`Prior conversation archived deterministically (~${estimateTokensFromChars(tokensBefore).toLocaleString()} ` +
		`tokens before compaction, ~${estimateTokensFromChars(archiveChars).toLocaleString()} kept below). ` +
		"Resume the prior conversation using this archive plus the recent messages that follow it."
	);
}

/** Frame separator marking one text page of the archive middle. */
function frameSeparator(index: number, total: number): string {
	return `-------------- [archive ${index + 1}/${total}] --------------`;
}

/**
 * Run one deterministic compaction pass. Pure: the host owns message
 * conversion, file-op extraction, and archive-state persistence.
 */
export function snapCompact(input: SnapCompactionInput): SnapCompactionResult {
	const serialized = serializeConversation(input.messages, input.serialize);

	// Unfold continuity: a prior snapcompact archive re-enters as source text;
	// otherwise a prior LLM summary rides in front so it is not lost.
	const previousText = input.previousArchive?.text ?? input.previousSummary ?? "";
	const source = previousText.length > 0 ? `${previousText}\n\n${serialized}` : serialized;

	const budget = input.archiveMaxChars ?? DEFAULT_ARCHIVE_MAX_CHARS;
	const layout = planArchive(source, budget);
	const truncatedChars = (input.previousArchive?.truncatedChars ?? 0) + layout.truncatedChars;

	const { readFiles, modifiedFiles } = computeFileLists(input.fileOps);
	const filesSection = formatFilesSection(readFiles, modifiedFiles, input.fileOps.read);

	// Archive region: verbatim head edge → elision notice → middle pages →
	// verbatim tail edge. Short histories are a single verbatim region.
	const archiveParts: string[] = [];
	if (layout.frames.length === 0) {
		archiveParts.push(layout.textHead);
	} else {
		archiveParts.push(layout.textHead);
		if (truncatedChars > 0) archiveParts.push(elisionNotice(truncatedChars));
		const total = layout.frames.length;
		for (const frame of layout.frames) {
			const start = frame.index * FRAME_CHAR_CAPACITY;
			archiveParts.push(`${frameSeparator(frame.index, total)}\n${layout.middle.slice(start, start + frame.chars)}`);
		}
		archiveParts.push(layout.textTail);
	}
	const archiveRegion = archiveParts.filter((part) => part.length > 0).join("\n");

	const summarySections = [leadIn(source.length, archiveRegion.length), READING_GUIDE, archiveRegion];
	if (filesSection) summarySections.push(filesSection);
	const summary = summarySections.join("\n\n");

	const shortSummary =
		layout.frames.length === 0
			? `archived ${estimateTokensFromChars(source.length).toLocaleString()} tokens verbatim (no paging needed)`
			: `archived history into ${layout.frames.length} text frames` +
				(truncatedChars > 0 ? `, elided ${truncatedChars.toLocaleString()} oldest chars` : "");

	return {
		summary,
		shortSummary,
		archive: { text: layout.keptText, truncatedChars, version: SNAP_ARCHIVE_VERSION },
		frames: layout.frames,
		archiveChars: archiveRegion.length,
		readFiles,
		modifiedFiles,
	};
}
