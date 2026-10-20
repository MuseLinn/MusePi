/**
 * The tail inset arithmetic.
 *
 * The distinction this file pins down is the one that made the naive version
 * visibly wrong: the fade band follows the composer's CURRENT height, but the
 * list footer reserves the RESTING height plus a gap. Reserving the current
 * height instead would shove the transcript down on every keystroke as the
 * composer grows a line.
 */
import { describe, expect, it } from "bun:test";
import {
	FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX,
	FLOATING_COMPOSER_GAP_PX,
	forgetComposerSlot,
	recordComposerSlotHeight,
	resolveComposerTailInset,
} from "../src/lib/composer-tail-inset";

describe("composer tail inset", () => {
	it("reserves the resting height plus the gap", () => {
		const resting = 200;
		// Nothing has grown: the reservation is just the composer plus the band
		// the queue panel and docks live in.
		expect(resolveComposerTailInset(resting, resting)).toBe(resting + FLOATING_COMPOSER_GAP_PX);
	});

	it("absorbs growth up to the allowance before pushing the transcript", () => {
		const resting = 200;
		const modestGrowth = 40;
		// A composer that grew a little takes the gap, not the transcript: the
		// reservation must not change, or typing one line would scroll the list.
		expect(resolveComposerTailInset(resting, resting + modestGrowth)).toBe(resting + FLOATING_COMPOSER_GAP_PX);
	});

	it("pushes the transcript once the composer outgrows the allowance", () => {
		const resting = 200;
		const hugeGrowth = 400;
		const inset = resolveComposerTailInset(resting, resting + hugeGrowth);
		// Past the allowance the band has to grow, or the last row hides under a
		// composer that now covers far more than the reserved gap.
		expect(inset).toBeGreaterThan(resting + FLOATING_COMPOSER_GAP_PX);
		expect(inset).toBeLessThan(resting + hugeGrowth);
	});

	it("tracks the minimum ever measured as the resting height", () => {
		// A session that opens with a queue row already present measures tall
		// first; the rest height must settle on the shortest measurement, or the
		// reservation stays permanently inflated.
		const column = {} as HTMLElement;
		recordComposerSlotHeight(column, 300);
		const shrunk = recordComposerSlotHeight(column, 180);
		const regrown = recordComposerSlotHeight(column, 240);
		expect(shrunk.tailInset).toBe(180 + FLOATING_COMPOSER_GAP_PX);
		// 240 is within the growth allowance of the 180 rest, so no push.
		expect(regrown.tailInset).toBe(180 + FLOATING_COMPOSER_GAP_PX);
		expect(regrown.grown).toBe(true);
		forgetComposerSlot(column);
	});

	it("falls back to a sane reservation before anything has been measured", () => {
		const column = {} as HTMLElement;
		// A slot that has not laid out yet reports zero; reserving zero would
		// hide the last row for a frame.
		expect(recordComposerSlotHeight(column, 0).tailInset).toBe(FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX);
		forgetComposerSlot(column);
	});
});
