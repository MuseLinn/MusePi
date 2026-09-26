import { describe, expect, it } from "bun:test";
import { computeMorph, type MorphRect } from "../src/components/image-morph";

/**
 * Contract (M1.10 §3.3 一镜到底): the lightbox flight is computed by a pure
 * function — translate + scale from a `top left` transform origin that maps
 * the stage-rect element exactly onto the source thumbnail rect. A wrong
 * morph teleports the flying image (bad dx/dy) or squashes it (bad sx/sy);
 * a degenerate source must return null so the caller falls back to the
 * plain fade instead of flying from a zero-sized box.
 */
const rect = (left: number, top: number, width: number, height: number): MorphRect => ({ left, top, width, height });

describe("computeMorph", () => {
	it("identical rects → zero transform (no flight needed)", () => {
		const r = rect(10, 20, 300, 200);
		expect(computeMorph(r, r)).toEqual({ dx: 0, dy: 0, sx: 1, sy: 1 });
	});

	it("translation moves the target's top-left onto the origin's", () => {
		const m = computeMorph(rect(100, 50, 200, 100), rect(40, 80, 400, 200));
		expect(m).not.toBeNull();
		expect(m!.dx).toBe(60);
		expect(m!.dy).toBe(-30);
	});

	it("scale is the origin/target size ratio per axis (non-uniform kept)", () => {
		const m = computeMorph(rect(0, 0, 100, 400), rect(0, 0, 200, 200));
		expect(m!.sx).toBe(0.5);
		expect(m!.sy).toBe(2);
	});

	it("transformed target corners land exactly on the origin's corners", () => {
		const origin = rect(37, -12, 96, 64);
		const target = rect(0, 0, 800, 600);
		const m = computeMorph(origin, target)!;
		// top-left: translate alone
		expect(target.left + m.dx).toBe(origin.left);
		expect(target.top + m.dy).toBe(origin.top);
		// bottom-right: translate + scale about the (unmoved) top-left —
		// i.e. the flight aligns the whole box, center included
		expect(target.left + m.dx + target.width * m.sx).toBeCloseTo(origin.left + origin.width);
		expect(target.top + m.dy + target.height * m.sy).toBeCloseTo(origin.top + origin.height);
	});

	it("degenerate inputs → null (caller degrades to the fade)", () => {
		const ok = rect(0, 0, 10, 10);
		expect(computeMorph(rect(0, 0, 0, 10), ok)).toBeNull();
		expect(computeMorph(rect(0, 0, 10, 0), ok)).toBeNull();
		expect(computeMorph(rect(0, 0, -5, 10), ok)).toBeNull();
		expect(computeMorph(rect(Number.NaN, 0, 10, 10), ok)).toBeNull();
		expect(computeMorph(ok, rect(0, 0, Number.POSITIVE_INFINITY, 10))).toBeNull();
	});
});
