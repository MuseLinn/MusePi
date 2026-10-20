/**
 * The image preview's control labels, plus the zoom helpers' unit tests.
 */
import { describe, expect, it } from "bun:test";
// Imported from the module rather than the barrel: the barrel pulls in
// components that need a DOM, and these helpers are pure arithmetic.
import {
	clampImageScale,
	fitImageScale,
	IMAGE_VIEWPORT_PADDING,
	stepImageScale,
	wheelZoomFactor,
} from "../../client-core/src/components/image-zoom";

describe("image zoom arithmetic", () => {
	it("fits an image whole and never upscales a small one", () => {
		// A 16px icon shown at panel size would blur into a smear; fit means
		// "as big as it goes without exceeding the panel".
		const viewport = { width: 800, height: 600 };
		expect(fitImageScale({ width: 400, height: 300 }, viewport)).toBe(1);
		expect(fitImageScale({ width: 16, height: 16 }, viewport)).toBe(1);
		// A 1600x1200 image in an 800x600 viewer fits at half — less, because
		// the padding is what makes "whole" mean whole.
		expect(fitImageScale({ width: 1600, height: 1200 }, viewport)).toBeLessThan(0.5);
		expect(fitImageScale({ width: 1600, height: 1200 }, viewport)).toBeGreaterThan(0.4);
		// The padding is what makes "whole" mean whole.
		const exact = { width: 800 - IMAGE_VIEWPORT_PADDING * 2, height: 600 - IMAGE_VIEWPORT_PADDING * 2 };
		expect(fitImageScale(exact, viewport)).toBeCloseTo(1, 5);
	});

	it("clamps a zoom into its range without going below the image's own fit", () => {
		// A huge image may be zoomed out below 1:1, but never so far that it
		// becomes smaller than it fits.
		expect(clampImageScale(100, 0.5)).toBe(16);
		expect(clampImageScale(2, 0.5)).toBe(2);
		// The floor is the tighter of the two bounds: an image that fits at
		// 2% may be zoomed out to 2%, but not past it.
		expect(clampImageScale(0.001, 0.02)).toBe(0.02);
		expect(clampImageScale(0.001, 0.5)).toBe(0.1);
	});

	it("steps to the next preset level, in both directions", () => {
		expect(stepImageScale(1, 1)).toBe(1.5);
		expect(stepImageScale(1.5, 1)).toBe(2);
		expect(stepImageScale(1, -1)).toBe(0.75);
		expect(stepImageScale(0.75, -1)).toBe(0.5);
		// The ends of the ladder stay put.
		expect(stepImageScale(16, 1)).toBe(16);
		expect(stepImageScale(0.1, -1)).toBe(0.1);
	});

	it("turns a wheel delta into a scale factor, capped per event", () => {
		// A mouse notch is one large delta; a trackpad pinch sends many small
		// ones. Both must move the scale by a sane amount.
		expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
		expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
		// A huge delta is capped, so one notch cannot jump levels.
		const capped = wheelZoomFactor(-100000, 0);
		expect(capped).toBeCloseTo(wheelZoomFactor(-30, 0), 6);
		// Line mode multiplies the delta into pixels.
		expect(wheelZoomFactor(-1, 1)).toBeCloseTo(wheelZoomFactor(-16, 0), 6);
	});
});
