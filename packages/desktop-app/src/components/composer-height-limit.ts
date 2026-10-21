/**
 * The composer's height cap.
 *
 * Two independent limits, and both matter now that the composer floats:
 *
 *  - **lines** — a textarea that grows past ~8 rows turns the input into a
 *    document and pushes the conversation off screen;
 *  - **available height** — on a short window (or with the context panel open)
 *    even 8 rows may leave the transcript unusable. The cap is the smaller of
 *    the two, so the input never eats the surface it is floating over.
 *
 * The overflow test is subtler than `scrollHeight > cap`: content that exactly
 * fits still reports a pixel or two of overflow from the drawn caret, font
 * metrics and rounding, and classic scrollbars on Windows and Linux paint that
 * as a useless sliver beside the send button. Real overflow at the cap is at
 * least half a line.
 *
 */

export interface ComposerHeightLimitOptions {
	/** The line-based cap: lineHeight × maxRows. */
	readonly maxLinesHeight: number;
	/** Height of the box the composer floats over, when known. */
	readonly boundHeight?: number;
	/** Height of everything else already inside that box, when known. */
	readonly surroundingHeight?: number;
	/** Breathing room to leave between the composer and the box's top edge. */
	readonly boundGapPx?: number;
}

/**
 * The effective cap: the line limit, lowered to whatever the surrounding box
 * can spare.
 */
export function getComposerHeightLimit(options: ComposerHeightLimitOptions): number {
	const { maxLinesHeight, boundHeight, surroundingHeight, boundGapPx = 0 } = options;
	let limit = maxLinesHeight;
	if (boundHeight !== undefined && surroundingHeight !== undefined) {
		const available = boundHeight - surroundingHeight - boundGapPx;
		// A negative budget means the box is already full: keep the line cap
		// rather than collapsing the composer to zero.
		if (available > 0) limit = Math.min(limit, available);
	}
	return limit;
}

/**
 * Whether the content really outgrew the cap, so the scroller should offer a
 * vertical scrollbar.
 *
 * Sub-half-line overflow is measurement noise, not content: showing a scrollbar
 * for it gives the user a control that cannot scroll anywhere.
 */
export function isComposerContentCapped(contentHeight: number, cap: number, lineHeight: number): boolean {
	return contentHeight - cap > lineHeight / 2;
}
