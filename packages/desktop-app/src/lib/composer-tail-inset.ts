/**
 * How much of the transcript's end the floating composer reserves.
 *
 * Two different numbers, and confusing them is why the naive version hid the
 * last row:
 *
 *  - `inset` — the composer slot's **current** height. The end fade reads it
 *    so the band it fades over always matches the glass it meets.
 *  - `tailInset` — what the list footer reserves. This is the *resting* height
 *    plus a gap, not the current height: a composer that grows (a queue row, an
 *    approval dock, six lines of text) takes the gap first and only pushes the
 *    transcript past its growth allowance. Reserving the current height would
 *    make the transcript jump every time the user types a line.
 *
 * One subtlety: the resting height is the MINIMUM ever measured, and the
 * measurement starts when the composer mounts — but structural rows (the
 * connector chip, plugin rows on the composer.dock seat) mount ASYNCHRONOUSLY
 * after their RPC / registry import. Latching the minimum from those first
 * seconds freezes the reservation below the composer's real resting height,
 * and the transcript's last row hides under those rows for the whole session.
 * So the minimum is only latched after a warmup window (measured from the
 * first real measurement); during warmup the CURRENT height is reserved,
 * which is safe because a session that just opened is still settling anyway.
 *
 */

/**
 * Gap between the last transcript row and the resting composer's top edge, on
 * top of the composer's own height. Generous on purpose: the queue panel, the
 * jump-back dock and the session-tree nav all land in this band, and a follow
 * glide that trails the live edge should still leave the last line clear of the
 * glass.
 */
export const FLOATING_COMPOSER_GAP_PX = 80;

/**
 * How far the composer may grow above its resting height before it starts
 * pushing the transcript. The band reserved at rest is `gap` plus the last
 * turn's own bottom padding; taking this much of it back leaves a few pixels
 * of clearance above the glass.
 */
const FLOATING_COMPOSER_GROWTH_ALLOWANCE_PX = 88;

/** Footer reserve before the floating composer has been measured at all. */
const FLOATING_COMPOSER_DEFAULT_HEIGHT = 128;

export const FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX = FLOATING_COMPOSER_DEFAULT_HEIGHT + FLOATING_COMPOSER_GAP_PX;

/**
 * How long the minimum-latch stays open, measured from the column's first
 * real (height > 0) measurement. Structural rows that mount asynchronously
 * (connector chip, composer.dock plugin rows) land inside this window; the
 * reservation follows the current height until it closes, then the minimum
 * ever measured becomes the resting height as before.
 */
export const FLOATING_COMPOSER_WARMUP_MS = 2_000;

/** Resting slot height per chat column, while its floating composer is measured. */
const restingHeights = new WeakMap<HTMLElement, number>();

/** First real measurement time per chat column (warmup anchor). */
const firstMeasuredAt = new WeakMap<HTMLElement, number>();

/** The tail inset for a measured composer, given the column's resting height. */
export function resolveComposerTailInset(restingHeight: number, height: number): number {
	return Math.max(
		restingHeight + FLOATING_COMPOSER_GAP_PX,
		height + FLOATING_COMPOSER_GAP_PX - FLOATING_COMPOSER_GROWTH_ALLOWANCE_PX,
	);
}

/**
 * Records a measured slot height for the column and returns the tail inset it
 * should publish, plus whether the composer is taller than at rest.
 *
 * The resting height is the **minimum** ever measured — but only AFTER the
 * warmup window: a composer only rests at its shortest, yet its shortest
 * structural form may not exist yet during the first seconds (async rows),
 * so before the window closes the current height is reserved and nothing is
 * latched. `now` is injectable for tests.
 */
export function recordComposerSlotHeight(
	column: HTMLElement,
	height: number,
	now: number = Date.now(),
): { tailInset: number; grown: boolean } {
	const seenAt = firstMeasuredAt.get(column);
	if (seenAt === undefined) {
		if (height <= 0) {
			// Not laid out yet: keep the default reservation for a frame.
			return { tailInset: FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX, grown: false };
		}
		firstMeasuredAt.set(column, now);
		// First real measurement is still inside the warmup window by definition.
		return { tailInset: height + FLOATING_COMPOSER_GAP_PX, grown: false };
	}
	if (now - seenAt < FLOATING_COMPOSER_WARMUP_MS) {
		if (height <= 0) {
			return { tailInset: FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX, grown: false };
		}
		return { tailInset: height + FLOATING_COMPOSER_GAP_PX, grown: false };
	}
	const previous = restingHeights.get(column);
	const resting = height > 0 ? Math.min(previous ?? height, height) : previous;
	if (resting === undefined) {
		return { tailInset: FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX, grown: false };
	}
	restingHeights.set(column, resting);
	return { tailInset: resolveComposerTailInset(resting, height), grown: height > resting };
}

/** A column unmounted: forget its resting height so a remount re-measures. */
export function forgetComposerSlot(column: HTMLElement): void {
	restingHeights.delete(column);
	firstMeasuredAt.delete(column);
}
