import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { assertCanvasHasContent, cappedPixelRatio, opaqueBackground, pixelsDiffer } from "../src/lib/rasterize";

/**
 * The export pipeline's silent failure modes, each measured on the real card
 * before this suite existed:
 *
 * 1. A transparent wrapper exported as a PNG of nothing — a dark theme's light
 *    text landed on transparency and vanished in any white-backed viewer.
 * 2. An oversized card exceeded Chromium's canvas cap, and the rasterizer
 *    answered with an empty blob that read as "the button is broken".
 * 3. An SVG decode/draw failure returned a *valid, nonempty* PNG holding only
 *    the background — the exact shape of the bug that shipped a blank
 *    "copied" image, and one no `if (!blob)` check can catch.
 *
 * The rest of `rasterizeToBlob` needs a real browser (shadow frames,
 * html-to-image), and the test DOM has no canvas 2D context, so the rules that
 * decide *whether the result is usable* are exercised directly.
 */

function mount(styles: Record<string, string>): HTMLElement {
	const el = document.createElement("div");
	Object.assign(el.style, styles);
	document.body.appendChild(el);
	return el;
}

const OPAQUE_GREY = [35, 35, 39, 255];
const OPAQUE_BLUE = [79, 140, 255, 255];
const CLEAR = [0, 0, 0, 0];

describe("widget image export", () => {
	it("walks up to the first opaque ancestor instead of the transparent wrapper", () => {
		// The live card wrapper has no background of its own; the surface the
		// user sees behind it belongs to an ancestor (the transcript body).
		const surface = mount({ backgroundColor: "rgb(35, 35, 39)" });
		const card = document.createElement("div");
		card.style.backgroundColor = "rgba(0, 0, 0, 0)";
		surface.appendChild(card);
		expect(opaqueBackground(card, "#ffffff")).toBe("rgb(35, 35, 39)");
	});

	it("skips a near-transparent ancestor and keeps climbing", () => {
		const card = mount({ backgroundColor: "rgba(0, 0, 0, 0)" });
		const middle = document.createElement("div");
		middle.style.backgroundColor = "rgba(255, 255, 255, 0.01)";
		card.appendChild(middle);
		expect(opaqueBackground(middle, "#ffffff")).toBe("#ffffff");
	});

	it("keeps the requested ratio for a card inside the canvas cap", () => {
		expect(cappedPixelRatio(2, 520, 180)).toBe(2);
	});

	it("shrinks the ratio rather than producing an empty canvas", () => {
		// 12000 × 2 = 24000, past Chromium's 16384 edge.
		expect(cappedPixelRatio(2, 12000, 400)).toBeCloseTo(16384 / 12000, 5);
		// Never below 1: a card taller than the cap still exports at 1×.
		expect(cappedPixelRatio(2, 40000, 400)).toBe(1);
	});

	it("treats a background-only raster as blank", () => {
		// The guard's own contract: identical pixels all the way down means the
		// SVG drew nothing. The canvas call path needs a real 2D context.
		expect(pixelsDiffer(OPAQUE_GREY, OPAQUE_GREY)).toBe(false);
		expect(pixelsDiffer(CLEAR, CLEAR)).toBe(false);
	});

	it("notices content against the background", () => {
		expect(pixelsDiffer(OPAQUE_GREY, OPAQUE_BLUE)).toBe(true);
		// Content on a transparent export still counts: the alpha differs.
		expect(pixelsDiffer(CLEAR, OPAQUE_BLUE)).toBe(true);
	});

	it("ignores sub-perceptual rounding", () => {
		expect(pixelsDiffer([35, 35, 39, 255], [36, 36, 40, 255])).toBe(false);
	});

	it("refuses a canvas with no drawable surface", () => {
		// No 2D context here (and none in a headless DOM): the guard must call
		// that empty rather than sample zeroes and call it content.
		expect(() => assertCanvasHasContent(document.createElement("canvas"))).toThrow(/empty|blank/);
	});
});
