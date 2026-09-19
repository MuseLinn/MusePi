import { describe, expect, it } from "bun:test";
import {
	acceptsShapeDrag,
	dragBox,
	hasVisibleExtent,
	heartPoints,
	isDegenerateDrag,
	outlinePoints,
	scalePoints,
	shiftPoints,
	starOuterPoints,
	strokeBox,
	strokeExtent,
	textFontSize,
	textLabelBox,
} from "../src/lib/sketch-geometry";

/** SketchPad shape-maths contract (Codex-parity pass, 2026-09-19).
 *
 *  These functions decide what actually lands on the exported PNG, so the
 *  assertions are geometric rather than snapshot: a star must point up, a
 *  heart must fill its box, a tap must not create a node. */
describe("dragBox", () => {
	it("normalizes a bottom-right drag", () => {
		expect(dragBox(10, 20, 40, 60)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
	});

	it("normalizes a top-left drag into the same box", () => {
		// Dragging right-to-left / bottom-to-top is how half of all people draw;
		// both directions must produce an identical, positive-extent box.
		expect(dragBox(40, 60, 10, 20)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
	});

	it("keeps a zero-extent drag at the origin corner", () => {
		expect(dragBox(5, 5, 5, 5)).toEqual({ x: 5, y: 5, w: 0, h: 0 });
	});
});

describe("isDegenerateDrag", () => {
	it("treats a tap as degenerate", () => {
		expect(isDegenerateDrag(100, 100, 100, 100)).toBe(true);
	});

	it("treats a 1px jitter as degenerate", () => {
		expect(isDegenerateDrag(100, 100, 101, 100.5)).toBe(true);
	});

	it("accepts a real drag on either axis", () => {
		expect(isDegenerateDrag(100, 100, 140, 100)).toBe(false);
		expect(isDegenerateDrag(100, 100, 100, 140)).toBe(false);
	});
});

describe("acceptsShapeDrag", () => {
	const points = [0, 0, 40, 40];

	it("accepts a real drag for every shape tool", () => {
		for (const tool of ["line", "arrow", "rect", "ellipse", "diamond", "triangle", "star", "heart"] as const) {
			expect(acceptsShapeDrag(tool, points)).toBe(true);
		}
	});

	it("rejects a tap for every shape tool", () => {
		for (const tool of ["line", "arrow", "rect", "ellipse", "diamond", "triangle", "star", "heart"] as const) {
			expect(acceptsShapeDrag(tool, [7, 7, 7, 7])).toBe(false);
		}
	});
});

describe("starOuterPoints", () => {
	const box = { x: 0, y: 0, w: 100, h: 100 };

	it("emits an outer+inner point per spike", () => {
		expect(starOuterPoints(box).length).toBe(5 * 2 * 2);
	});

	it("points the first spike straight up", () => {
		const p = starOuterPoints(box);
		expect(p[0]).toBeCloseTo(50);
		// -90° from the centre with ry=50 is the top edge.
		expect(p[1]).toBeCloseTo(0);
	});

	it("puts the second point (inner) closer to the centre than the first", () => {
		const p = starOuterPoints(box);
		const outer = Math.hypot(p[0] - 50, p[1] - 50);
		const inner = Math.hypot(p[2] - 50, p[3] - 50);
		expect(inner).toBeLessThan(outer);
		expect(inner).toBeCloseTo(outer * 0.42, 5);
	});

	it("stays inside the drag box on both axes", () => {
		const p = starOuterPoints({ x: 10, y: 20, w: 80, h: 40 });
		for (let i = 0; i < p.length; i += 2) {
			expect(p[i]).toBeGreaterThanOrEqual(10 - 1e-9);
			expect(p[i]).toBeLessThanOrEqual(90 + 1e-9);
			expect(p[i + 1]).toBeGreaterThanOrEqual(20 - 1e-9);
			expect(p[i + 1]).toBeLessThanOrEqual(60 + 1e-9);
		}
	});

	it("centres on a non-square box", () => {
		const p = starOuterPoints({ x: 0, y: 0, w: 200, h: 50 });
		// The up-spike always sits at the horizontal centre.
		expect(p[0]).toBeCloseTo(100);
	});
});

describe("heartPoints", () => {
	const box = { x: 0, y: 0, w: 100, h: 100 };

	it("spans the full width of the drag box (x is exactly ±1 normalized)", () => {
		// x = 16sin³t hits both extremes at t=π/2 and t=3π/2, so the lobes
		// touch the left and right edges exactly.
		const p = heartPoints(box);
		let minX = Infinity;
		let maxX = -Infinity;
		for (let i = 0; i < p.length; i += 2) {
			minX = Math.min(minX, p[i]);
			maxX = Math.max(maxX, p[i]);
		}
		expect(minX).toBeCloseTo(0, 1);
		expect(maxX).toBeCloseTo(100, 1);
	});

	it("keeps the notch clear of the top edge and the tip on the bottom edge", () => {
		// The raw curve's y range is asymmetric ([−17, 11.92]), so a naive
		// single-divisor mapping hangs the bottom tip below the box. Both
		// edges are pinned here so that regression can't come back.
		const p = heartPoints(box, 48);
		// Sample 0 is t=0 — the notch, at the horizontal centre.
		expect(p[0]).toBeCloseTo(50);
		expect(p[1]).toBeGreaterThan(0);
		let maxY = -Infinity;
		let minY = Infinity;
		for (let i = 1; i < p.length; i += 2) {
			maxY = Math.max(maxY, p[i]);
			minY = Math.min(minY, p[i]);
		}
		expect(maxY).toBeCloseTo(100, 1);
		expect(minY).toBeCloseTo(0, 1);
	});

	it("stays inside the drag box on both axes", () => {
		const p = heartPoints({ x: 10, y: 20, w: 80, h: 40 });
		for (let i = 0; i < p.length; i += 2) {
			expect(p[i]).toBeGreaterThanOrEqual(10 - 1e-9);
			expect(p[i]).toBeLessThanOrEqual(90 + 1e-9);
			expect(p[i + 1]).toBeGreaterThanOrEqual(20 - 1e-9);
			expect(p[i + 1]).toBeLessThanOrEqual(60 + 1e-9);
		}
	});

	it("is horizontally symmetric about the box centre", () => {
		const p = heartPoints(box, 64);
		// t and 2π−t are mirror images: x flips sign about the centre while y
		// repeats. So sample i and sample n−i must sit at the same y, at
		// mirrored x — NOT at identical coordinates.
		const n = p.length / 2;
		for (let i = 1; i < n / 2; i++) {
			const a = i * 2;
			const b = (n - i) * 2;
			expect(p[a] - 50).toBeCloseTo(-(p[b] - 50), 4);
			expect(p[a + 1]).toBeCloseTo(p[b + 1], 4);
		}
	});

	it("puts the bottom tip on the vertical centre line", () => {
		// t=π is the cusp of the two lobes; it is the only other point at x=50.
		const p = heartPoints(box, 64);
		expect(p[64]).toBeCloseTo(50, 4);
	});

	it("scales with a non-square box", () => {
		const p = heartPoints({ x: 0, y: 0, w: 60, h: 120 });
		let maxY = -Infinity;
		let maxX = -Infinity;
		for (let i = 0; i < p.length; i += 2) {
			maxX = Math.max(maxX, p[i]);
			maxY = Math.max(maxY, p[i + 1]);
		}
		// Width 60 → lobes reach x=60; height 120 → tip reaches y=120.
		expect(maxX).toBeCloseTo(60, 1);
		expect(maxY).toBeCloseTo(120, 1);
	});
});

describe("outlinePoints", () => {
	it("returns null for the Konva primitives", () => {
		expect(outlinePoints("rect", [0, 0, 10, 10])).toBeNull();
		expect(outlinePoints("ellipse", [0, 0, 10, 10])).toBeNull();
		expect(outlinePoints("line", [0, 0, 10, 10])).toBeNull();
		expect(outlinePoints("arrow", [0, 0, 10, 10])).toBeNull();
	});

	it("builds a triangle from the box corners", () => {
		expect(outlinePoints("triangle", [0, 0, 100, 60])).toEqual([50, 0, 100, 60, 0, 60]);
	});

	it("builds a diamond from the box mid-edges", () => {
		expect(outlinePoints("diamond", [0, 0, 100, 60])).toEqual([50, 0, 100, 30, 50, 60, 0, 30]);
	});

	it("normalizes the drag before building a diamond", () => {
		// Bottom-right-to-top-left must give the same diamond. This is the
		// assertion that fails if a generator ever reads `points` raw instead
		// of going through dragBox.
		expect(outlinePoints("diamond", [100, 60, 0, 0])).toEqual([50, 0, 100, 30, 50, 60, 0, 30]);
	});

	it("normalizes the drag before building a triangle", () => {
		expect(outlinePoints("triangle", [100, 60, 0, 0])).toEqual([50, 0, 100, 60, 0, 60]);
	});

	it("normalizes the drag for star and heart too", () => {
		// Same guard as the diamond above, for the sampled shapes.
		expect(outlinePoints("star", [100, 100, 0, 0])).toEqual(outlinePoints("star", [0, 0, 100, 100]));
		expect(outlinePoints("heart", [100, 100, 0, 0])).toEqual(outlinePoints("heart", [0, 0, 100, 100]));
	});

	it("delegates star and heart to their generators", () => {
		expect(outlinePoints("star", [0, 0, 100, 100])).toEqual(starOuterPoints(dragBox(0, 0, 100, 100)));
		expect(outlinePoints("heart", [0, 0, 100, 100])).toEqual(heartPoints(dragBox(0, 0, 100, 100)));
	});
});

describe("strokeBox", () => {
	it("bounds a shape drag and pads it for line width", () => {
		const box = strokeBox({ tool: "rect", size: 4, points: [10, 10, 70, 50] });
		const pad = 4 * 1.8 + 4;
		expect(box.x).toBeCloseTo(10 - pad);
		expect(box.y).toBeCloseTo(10 - pad);
		expect(box.w).toBeCloseTo(60 + pad * 2);
		expect(box.h).toBeCloseTo(40 + pad * 2);
	});

	it("bounds pen ink from its triplets", () => {
		const box = strokeBox({ tool: "pen", size: 2, points: [0, 0, 0.5, 30, 40, 0.5] });
		const pad = 2 * 1.8 + 4;
		expect(box.x).toBeCloseTo(-pad);
		expect(box.w).toBeCloseTo(30 + pad * 2);
	});

	it("uses the measured label size for text, not the anchor alone", () => {
		// A text stroke stores only its anchor; without the label the select
		// frame would collapse to a padded dot.
		const box = strokeBox({ tool: "text", size: 4, points: [20, 30] }, "Hello");
		const pad = 4 * 1.8 + 4;
		const { w, h } = textLabelBox(4, "Hello");
		expect(box.w).toBeCloseTo(w + pad * 2);
		expect(box.h).toBeCloseTo(h + pad * 2);
	});

	it("gives text a non-empty frame at an empty label", () => {
		// Even an empty label keeps the pad, so the frame never disappears.
		const box = strokeBox({ tool: "text", size: 4, points: [20, 30] }, "");
		expect(box.w).toBeGreaterThan(0);
	});

	it("widens the text frame with the label length", () => {
		const short = strokeBox({ tool: "text", size: 4, points: [0, 0] }, "ab");
		const long = strokeBox({ tool: "text", size: 4, points: [0, 0] }, "abcdefghij");
		expect(long.w).toBeGreaterThan(short.w);
	});
});

describe("textLabelBox / textFontSize", () => {
	it("keeps a legible minimum glyph size for hairline strokes", () => {
		// size 1 would be a 4px glyph — unreadable, and the caret overlay
		// could not be typed into.
		expect(textFontSize(1)).toBe(14);
		expect(textFontSize(3)).toBe(14);
	});

	it("scales the glyph with the thickness slider above the floor", () => {
		expect(textFontSize(10)).toBe(40);
		expect(textFontSize(24)).toBe(96);
	});

	it("grows the measured box with the glyph size", () => {
		const thin = textLabelBox(2, "label");
		const thick = textLabelBox(20, "label");
		expect(thick.w).toBeGreaterThan(thin.w);
		expect(thick.h).toBeGreaterThan(thin.h);
	});

	it("gives an empty label a tappable minimum", () => {
		// At size 4 the glyph floor gives fs=16 → height 16×1.3 = 20.8, while a
		// zero-length label has no advance at all and floors at 20px of width.
		const { w, h } = textLabelBox(4, "");
		expect(w).toBe(20);
		expect(h).toBe(20.8);
	});

	it("derives height from the glyph ladder, not a flat constant", () => {
		// size 20 → fs 80 → height 104; the 20px floor must not clamp it.
		expect(textLabelBox(20, "").h).toBe(104);
	});
});

describe("hasVisibleExtent", () => {
	it("accepts pen ink with enough points", () => {
		expect(hasVisibleExtent({ tool: "pen", points: [0, 0, 0.5, 1, 1, 0.5] })).toBe(true);
	});

	it("rejects a pen dot", () => {
		expect(hasVisibleExtent({ tool: "pen", points: [0, 0, 0.5] })).toBe(false);
	});

	it("accepts a wide-but-flat rect drag", () => {
		expect(hasVisibleExtent({ tool: "rect", points: [0, 50, 100, 50] })).toBe(true);
	});

	it("rejects a tapped rect", () => {
		expect(hasVisibleExtent({ tool: "rect", points: [50, 50, 50, 50] })).toBe(false);
	});

	it("rejects text parked at the origin", () => {
		expect(hasVisibleExtent({ tool: "text", points: [0, 0] })).toBe(false);
	});

	it("accepts real text", () => {
		expect(hasVisibleExtent({ tool: "text", points: [12, 40] })).toBe(true);
	});
});

describe("strokeExtent", () => {
	it("measures a shape from its two corners", () => {
		expect(strokeExtent({ tool: "rect", points: [10, 20, 70, 50] })).toEqual({ x: 10, y: 20, w: 60, h: 30 });
	});

	it("normalizes reversed corners", () => {
		expect(strokeExtent({ tool: "rect", points: [70, 50, 10, 20] })).toEqual({ x: 10, y: 20, w: 60, h: 30 });
	});

	it("walks pen triplets, skipping pressure", () => {
		const e = strokeExtent({ tool: "pen", points: [0, 0, 0.5, 30, 40, 0.5, 10, 100, 0.9] });
		expect(e).toEqual({ x: 0, y: 0, w: 30, h: 100 });
	});

	it("gives text a zero-size box at its anchor", () => {
		// The label extent is strokeBox's concern; extent stays the pure
		// coordinate box that scale handles anchor against.
		expect(strokeExtent({ tool: "text", points: [20, 30] })).toEqual({ x: 20, y: 30, w: 0, h: 0 });
	});
});

describe("shiftPoints", () => {
	it("moves a shape box", () => {
		expect(shiftPoints("rect", [10, 20, 70, 50], 5, -3)).toEqual([15, 17, 75, 47]);
	});

	it("moves a text anchor", () => {
		expect(shiftPoints("text", [20, 30], -12, 8)).toEqual([8, 38]);
	});

	it("moves pen coordinates by their own axis and passes pressure through", () => {
		// Regression lock: the pre-2026-09-19 inline formula shifted pen
		// points with an `i % 2` parity rule, so x-slots took dy and y-slots
		// took dx (index 3 is an x but odd, index 4 is a y but even) — every
		// diagonal drag sheared the ink. Both axes must move by their own
		// delta and every pressure slot must survive untouched.
		expect(shiftPoints("pen", [0, 0, 0.5, 30, 40, 0.9], 10, 100)).toEqual([10, 100, 0.5, 40, 140, 0.9]);
	});

	it("does not mutate the input array", () => {
		// The component keeps `from` around for the undo op; an in-place
		// shift would corrupt the recorded origin.
		const src = [10, 20, 70, 50];
		shiftPoints("rect", src, 5, 5);
		expect(src).toEqual([10, 20, 70, 50]);
	});
});

describe("scalePoints", () => {
	it("is the identity at factor 1", () => {
		expect(scalePoints("rect", [10, 20, 70, 50], 0, 0, 1)).toEqual([10, 20, 70, 50]);
	});

	it("doubles distances from the anchor", () => {
		expect(scalePoints("rect", [10, 20, 70, 50], 0, 0, 2)).toEqual([20, 40, 140, 100]);
	});

	it("halves distances from the anchor", () => {
		expect(scalePoints("rect", [10, 20, 70, 50], 0, 0, 0.5)).toEqual([5, 10, 35, 25]);
	});

	it("keeps the anchor itself pinned", () => {
		// Anchor sits on the shape's corner: scaling away from it must leave
		// that corner exactly where it was — that is the handle contract.
		const out = scalePoints("rect", [10, 20, 70, 50], 10, 20, 3);
		expect(out[0]).toBe(10);
		expect(out[1]).toBe(20);
		expect(out[2]).toBe(190);
		expect(out[3]).toBe(110);
	});

	it("scales toward the anchor when points sit above-left of it", () => {
		// Negative offsets are the common case (anchor = bottom-right of the
		// selection, content up-left of it) — the sign must survive the
		// affine transform.
		expect(scalePoints("rect", [0, 0, 10, 10], 100, 100, 2)).toEqual([-100, -100, -80, -80]);
	});

	it("scales pen coordinates and passes pressure through", () => {
		expect(scalePoints("pen", [10, 10, 0.5, 30, 40, 0.9], 10, 10, 2)).toEqual([10, 10, 0.5, 50, 70, 0.9]);
	});

	it("scales a text anchor", () => {
		expect(scalePoints("text", [20, 30], 0, 0, 2)).toEqual([40, 60]);
	});

	it("clamps a runaway factor from above", () => {
		const out = scalePoints("rect", [10, 20, 70, 50], 0, 0, 1000);
		expect(out[0]).toBe(10 * 40);
	});

	it("clamps a collapsing factor from below", () => {
		// Below 0.05 every shape folds onto its anchor and becomes an
		// un-clickable dot; the floor holds instead.
		const out = scalePoints("rect", [10, 20, 70, 50], 0, 0, 0.0001);
		expect(out[0]).toBeCloseTo(10 * 0.05);
	});
});
