import { describe, expect, test } from "bun:test";
import { textScaleFrom } from "./text-scale";

/**
 * Physical text-scale normalisation: `xdpi / density / 153.3`, clamped. The
 * reference value comes from the design-system contract (iPhone Pro class:
 * 460 ppi at 3x → 153.3 logical dpi).
 */

describe("textScaleFrom", () => {
	test("the reference device is exactly 1", () => {
		expect(textScaleFrom({ xdpi: 460, density: 3 })).toBeCloseTo(1, 2);
	});

	test("a denser-than-reference logical pixel reads smaller", () => {
		// Mate X7 class: 415.6 xdpi at density 3.125 → 0.868 (contract example).
		expect(textScaleFrom({ xdpi: 415.6, density: 3.125 })).toBeCloseTo(0.868, 2);
	});

	test("a coarser logical pixel reads larger", () => {
		expect(textScaleFrom({ xdpi: 400, density: 2 })).toBeGreaterThan(1);
	});

	test("the correction is bounded in both directions", () => {
		expect(textScaleFrom({ xdpi: 2000, density: 1 })).toBe(1.18);
		expect(textScaleFrom({ xdpi: 90, density: 4 })).toBe(0.85);
	});

	test("missing or nonsense metrics never change the ladder", () => {
		expect(textScaleFrom(null)).toBe(1);
		expect(textScaleFrom(undefined)).toBe(1);
		expect(textScaleFrom({})).toBe(1);
		expect(textScaleFrom({ xdpi: 0, density: 3 })).toBe(1);
		expect(textScaleFrom({ xdpi: 460, density: 0 })).toBe(1);
		expect(textScaleFrom({ xdpi: Number.NaN, density: 3 })).toBe(1);
	});
});
