import { describe, expect, it } from "bun:test";
import {
	colorLuma,
	contrastRatio,
	ensureReadableColor,
	hslToHex,
	parseCssColor,
	relativeLuminance,
} from "@musepi/pi-utils/color";

describe("relativeLuminance (WCAG, linearized sRGB)", () => {
	it("hits the extremes", () => {
		expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
	});

	it("linearizes — mid-gray is WCAG-dark (~0.21), not 0.5", () => {
		// #808080 is perceptually mid (luma ~0.5) but WCAG-dark once linearized.
		expect(relativeLuminance("#808080") ?? 1).toBeLessThan(0.25);
		expect(colorLuma("#808080") ?? 0).toBeGreaterThan(0.45);
	});

	it("accepts #rgb shorthand and palette indices", () => {
		expect(relativeLuminance("#fff")).toBe(relativeLuminance("#ffffff"));
		expect(relativeLuminance(15)).toBeGreaterThan(0.9); // white
		expect(relativeLuminance(0)).toBeCloseTo(0, 5); // black
	});

	it("returns undefined for malformed / var-ref input", () => {
		expect(relativeLuminance("primary")).toBeUndefined();
		expect(relativeLuminance("#ff")).toBeUndefined();
		expect(relativeLuminance(256)).toBeUndefined();
	});
});

describe("colorLuma (perceptual classification)", () => {
	it("parses hex, shorthand, and palette indices", () => {
		expect(colorLuma("#000000")).toBeCloseTo(0, 5);
		expect(colorLuma("#ffffff")).toBeCloseTo(1, 5);
		expect(colorLuma("#fff")).toBe(colorLuma("#ffffff"));
		expect(colorLuma(15)).toBeGreaterThan(0.9);
	});

	it("returns undefined for malformed input", () => {
		expect(colorLuma("nope")).toBeUndefined();
		expect(colorLuma(-1)).toBeUndefined();
	});
});

describe("hslToHex", () => {
	it("maps primary hues at full saturation/half lightness", () => {
		expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
		expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
		expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
	});

	it("collapses to grayscale at zero saturation", () => {
		expect(hslToHex(0, 0, 0)).toBe("#000000");
		expect(hslToHex(210, 0, 1)).toBe("#ffffff");
	});
});

describe("contrastRatio", () => {
	it("scores black-on-white at the WCAG maximum and a mid-pair below it", () => {
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(contrastRatio("#767676", "#ffffff") ?? 0).toBeLessThan(4.6);
	});

	it("composites a translucent background before measuring", () => {
		// A 50% blue over white is a light blue, NOT the un-composited reading —
		// scoring raw channels would call white text readable on a light surface.
		// 50% blue over white is a light blue: white text on it measures ~3.3,
		// short of the 4.5 body-text bar. Scoring the raw un-composited channels
		// would instead read the background as pure blue and pass it.
		const ratio = contrastRatio("#ffffff", "rgba(0,0,255,0.5)", "#ffffff");
		expect(ratio ?? 99).toBeLessThan(4.5);
	});

	it("reads the rgb() and 8-digit forms getComputedStyle produces", () => {
		expect(contrastRatio("rgb(0, 0, 0)", "#fff")).toBeCloseTo(21, 5);
		expect(parseCssColor("#ffffff80")?.a).toBeCloseTo(0.5, 2);
	});

	it("returns undefined rather than a wrong number for unmeasurable values", () => {
		expect(contrastRatio("var(--fg)", "#ffffff")).toBeUndefined();
		expect(contrastRatio("#000000", "color-mix(in oklab, #fff, #000)")).toBeUndefined();
	});
});

describe("ensureReadableColor", () => {
	it("leaves an already-readable color untouched", () => {
		expect(ensureReadableColor("#1f2328", "#ffffff")).toBe("#1f2328");
		expect(ensureReadableColor("#ffffff", "#101114")).toBe("#ffffff");
	});

	it("fixes a color that disappears on the surface it lands on", () => {
		// The failure this defends: an author ships one blue accent, and a face
		// paints it on a tinted card where it is unreadable.
		const fixed = ensureReadableColor("#3b82f6", "#3b82f6");
		const ratio = contrastRatio(fixed, "#3b82f6") ?? 0;
		expect(ratio).toBeGreaterThanOrEqual(4.5);
		expect(fixed).not.toBe("#3b82f6");
	});

	it("keeps the author's hue instead of replacing it with black or white", () => {
		// A pure black or white rewrite would fix contrast while destroying the
		// design; the result must still read as the original color.
		const fixed = ensureReadableColor("#3b82f6", "#3b82f6");
		const rgb = parseCssColor(fixed);
		const original = parseCssColor("#3b82f6");
		expect(rgb && original).toBeTruthy();
		// Blue channel still dominant => still a blue.
		expect(rgb!.b).toBeGreaterThan(rgb!.r);
	});

	it("returns the input unchanged when it cannot measure", () => {
		expect(ensureReadableColor("var(--fg)", "#ffffff")).toBe("var(--fg)");
		expect(ensureReadableColor("#3b82f6", "color-mix(in oklab, #fff, #000)")).toBe("#3b82f6");
	});

	it("measures against the composited surface when a canvas is given", () => {
		const fixed = ensureReadableColor("#8a8a8a", "rgba(0,0,0,0.1)", 4.5, "#ffffff");
		expect(contrastRatio(fixed, "rgba(0,0,0,0.1)", "#ffffff") ?? 0).toBeGreaterThanOrEqual(4.4);
	});
});
