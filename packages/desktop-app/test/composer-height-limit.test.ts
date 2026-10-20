/**
 * The composer's height cap.
 *
 * Two limits, and the point of each is a distinct failure: without the line cap
 * the input becomes a document; without the available-height cap an eight-row
 * input on a short window leaves no conversation. The overflow test exists
 * because a scrollbar for sub-pixel overflow is a control that cannot scroll.
 */
import { describe, expect, it } from "bun:test";
import { getComposerHeightLimit, isComposerContentCapped } from "../src/components/composer-height-limit";

describe("composer height limit", () => {
	it("uses the line cap when nothing bounds it", () => {
		expect(getComposerHeightLimit({ maxLinesHeight: 176 })).toBe(176);
	});

	it("lowers the cap to whatever the surrounding box can spare", () => {
		// A 500px column with a 400px transcript leaves 100px, minus the gap.
		expect(
			getComposerHeightLimit({
				maxLinesHeight: 176,
				boundHeight: 500,
				surroundingHeight: 400,
				boundGapPx: 40,
			}),
		).toBe(60);
	});

	it("keeps the line cap when the box is already full", () => {
		// A negative budget must not collapse the composer to zero height —
		// that would leave the user with no input at all.
		expect(
			getComposerHeightLimit({
				maxLinesHeight: 176,
				boundHeight: 300,
				surroundingHeight: 400,
				boundGapPx: 40,
			}),
		).toBe(176);
	});

	it("never raises the cap above the line limit", () => {
		// A tall window must not let the composer grow past eight rows.
		expect(
			getComposerHeightLimit({
				maxLinesHeight: 176,
				boundHeight: 4000,
				surroundingHeight: 100,
				boundGapPx: 40,
			}),
		).toBe(176);
	});
});

describe("composer content overflow", () => {
	it("treats sub-half-line overflow as fitting", () => {
		// Content that exactly fits still reports a pixel or two from the drawn
		// caret, font metrics and rounding. A scrollbar for that cannot scroll.
		expect(isComposerContentCapped(177, 176, 20)).toBe(false);
		expect(isComposerContentCapped(186, 176, 20)).toBe(false);
	});

	it("reports a real overflow once it reaches half a line", () => {
		expect(isComposerContentCapped(187, 176, 20)).toBe(true);
		expect(isComposerContentCapped(400, 176, 20)).toBe(true);
	});
});
