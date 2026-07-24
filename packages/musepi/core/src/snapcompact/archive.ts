// ============================================================
// MusePi snapcompact — archive layout (OMP planArchive port).
//
// A "frame" here is a fixed-capacity text page — the text-mode analog of
// OMP's bitmap PNG frames, which we cannot rasterize without native code.
// Layout decision, identical in spirit to the bitmap version:
//   - history shorter than two edge pages stays fully verbatim (no frames);
//   - longer history keeps the oldest and newest edge verbatim and pages
//     the middle into frames;
//   - when the middle exceeds its budget the OLDEST slice is dropped
//     (recency bias), and the drop is accounted in truncatedChars.
// Token estimation is chars/4, the same heuristic pi's estimateTokens uses.
// ============================================================

import type { SnapFrame } from "./types.ts";

/** Characters in one text frame (~1500 tokens at chars/4). */
export const FRAME_CHAR_CAPACITY = 6000;

/** Archive character budget when the host does not derive one. */
export const DEFAULT_ARCHIVE_MAX_CHARS = 40_000;

/** chars/4 token estimate, matching pi's estimateTokens heuristic. */
export function estimateTokensFromChars(chars: number): number {
	return Math.ceil(chars / 4);
}

export interface ArchiveLayout {
	/** Oldest region kept verbatim. */
	textHead: string;
	/** Newest region kept verbatim. */
	textTail: string;
	/** Middle region after budget enforcement (frames are cut from this). */
	middle: string;
	/** Frame metadata for the middle (cut at FRAME_CHAR_CAPACITY). */
	frames: SnapFrame[];
	/** Characters dropped from the middle's oldest end in this pass. */
	truncatedChars: number;
	/** Full kept source to persist for the next pass. */
	keptText: string;
}

function cutFrames(middle: string): SnapFrame[] {
	const frames: SnapFrame[] = [];
	for (let start = 0, index = 0; start < middle.length; start += FRAME_CHAR_CAPACITY, index++) {
		frames.push({ index, chars: Math.min(FRAME_CHAR_CAPACITY, middle.length - start) });
	}
	return frames;
}

/**
 * Lay out accumulated archive text (oldest→newest). Edge pages stay
 * verbatim; the middle is budgeted and loses its oldest content first.
 */
export function planArchive(text: string, archiveMaxChars: number = DEFAULT_ARCHIVE_MAX_CHARS): ArchiveLayout {
	const budget = Math.max(2 * FRAME_CHAR_CAPACITY, archiveMaxChars);
	const edgeChars = Math.min(FRAME_CHAR_CAPACITY, Math.floor(budget / 4));

	// Short history: everything stays verbatim, no frames at all.
	if (text.length <= 2 * edgeChars) {
		return { textHead: text, textTail: "", middle: "", frames: [], truncatedChars: 0, keptText: text };
	}

	const textHead = text.slice(0, edgeChars);
	const textTail = text.slice(text.length - edgeChars);
	let middle = text.slice(edgeChars, text.length - edgeChars);

	const middleBudget = budget - 2 * edgeChars;
	let truncatedChars = 0;
	if (middle.length > middleBudget) {
		const excess = middle.length - middleBudget;
		truncatedChars = excess;
		middle = middle.slice(excess);
	}

	return {
		textHead,
		textTail,
		middle,
		frames: cutFrames(middle),
		truncatedChars,
		keptText: textHead + middle + textTail,
	};
}

/** Elision marker printed between the head edge and the middle when the
 *  archive dropped its oldest content. */
export function elisionNotice(truncatedChars: number): string {
	return `-------------- […${truncatedChars.toLocaleString()} chars of oldest history elided…] --------------`;
}
