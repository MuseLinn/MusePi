import { describe, expect, test } from "bun:test";
import chroma from "chroma-js";
import { petPaletteVars } from "../src/lib/pet-palette";

/** Channels of a WRITTEN oklch() var. The deliverable contract is the
 *  string the browser receives and gamut-maps (CSS Color 4): out-of-gamut
 *  oklch keeps hue+lightness and sheds chroma. Round-tripping through
 *  chroma.js instead clamps to sRGB and rotates the hue — an artifact of
 *  the test library, not of the shipped value — so hue assertions read
 *  the string directly. */
function oklchChannels(css: string): { l: number; c: number; h: number } {
	const m = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)deg/.exec(css);
	if (!m) throw new Error(`not an oklch() string: ${css}`);
	return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) };
}

/** oklch channels of an arbitrary accent color (chroma parse). */
function accentChannels(accent: string): { l: number; c: number; h: number } {
	const color = chroma(accent.trim());
	return { l: color.get("oklch.l"), c: color.get("oklch.c"), h: color.get("oklch.h") };
}

/** Circular hue distance in degrees (oklch hue wraps at 360). */
function hueDist(a: number, b: number): number {
	return Math.abs(((a - b + 540) % 360) - 180);
}

/** Brand gold (dark) — tokens.css `--accent` under data-theme=dark. */
const GOLD_DARK = "oklch(0.7507 0.1295 79.85)";
/** Brand gold (light). */
const GOLD_LIGHT = "oklch(0.62 0.115 79.85)";
/** Ocean accent (dark). */
const OCEAN_DARK = "oklch(0.65 0.16 255)";
/** Mono accent — near-neutral, the chroma-floor case. */
const MONO_DARK = "oklch(0.72 0.005 0)";

describe("petPaletteVars — derivation", () => {
	test("returns exactly the eight pet variables", () => {
		const v = petPaletteVars(GOLD_DARK, "dark");
		expect(Object.keys(v).sort()).toEqual(
			[
				"gui-pet-shell-a",
				"gui-pet-shell-b",
				"gui-pet-shell-c",
				"gui-pet-gold-a",
				"gui-pet-gold-b",
				"gui-pet-gold-c",
				"gui-pet-rim",
				"gui-pet-glow",
			].sort(),
		);
	});

	test("shell is accent-hued but heavily desaturated (dark)", () => {
		const v = petPaletteVars(OCEAN_DARK, "dark");
		const shellA = oklchChannels(v["gui-pet-shell-a"]);
		// Hue survives (the sphere follows the accent family — ocean stays
		// blue-grey, not the old hardcoded graphite-blue mismatch).
		expect(hueDist(shellA.h, 255)).toBeLessThan(0.1);
		expect(shellA.c).toBeLessThan(0.06);
		expect(shellA.l).toBeCloseTo(0.56, 1);
	});

	test("light family is tint → accent → shade on the accent hue", () => {
		const v = petPaletteVars(GOLD_DARK, "dark");
		const a = accentChannels(GOLD_DARK);
		// goldB IS the accent (chroma's css() rounds to two decimals).
		const goldB = oklchChannels(v["gui-pet-gold-b"]);
		expect(goldB.l).toBeCloseTo(a.l, 2);
		expect(goldB.c).toBeCloseTo(a.c, 2);
		expect(goldB.h).toBeCloseTo(a.h, 0);
		// Tint above, shade below, same hue.
		const goldA = oklchChannels(v["gui-pet-gold-a"]);
		const goldC = oklchChannels(v["gui-pet-gold-c"]);
		expect(goldA.l).toBeGreaterThan(a.l);
		expect(goldC.l).toBeLessThan(a.l);
		expect(hueDist(goldA.h, a.h)).toBeLessThan(0.1);
		expect(hueDist(goldC.h, a.h)).toBeLessThan(0.1);
	});

	test("shell ladder runs dark in dark mode, light in light mode", () => {
		const dark = petPaletteVars(GOLD_DARK, "dark");
		const light = petPaletteVars(GOLD_DARK, "light");
		const l = (css: string): number => oklchChannels(css).l;
		// Monotonic within each theme.
		expect(l(dark["gui-pet-shell-a"])).toBeGreaterThan(l(dark["gui-pet-shell-b"]));
		expect(l(dark["gui-pet-shell-b"])).toBeGreaterThan(l(dark["gui-pet-shell-c"]));
		// Dark-theme shell sits well below the light-theme shell.
		expect(l(dark["gui-pet-shell-a"])).toBeLessThan(l(light["gui-pet-shell-a"]));
	});

	test("brand gold lands near the original hardcoded golds (identity preserved)", () => {
		// goldB = the accent itself (dark ≈ the old #d9a83f family).
		const v = petPaletteVars(GOLD_DARK, "dark");
		const goldB = accentChannels(v["gui-pet-gold-b"]);
		const legacy = accentChannels("#d9a83f");
		expect(Math.abs(goldB.l - legacy.l)).toBeLessThan(0.06);
		expect(hueDist(goldB.h, legacy.h)).toBeLessThan(8);
	});

	test("light theme deepens the shade floor so eyes keep contrast", () => {
		const v = petPaletteVars(GOLD_LIGHT, "light");
		const goldC = oklchChannels(v["gui-pet-gold-c"]);
		expect(goldC.l).toBeGreaterThanOrEqual(0.3);
		expect(oklchChannels(v["gui-pet-shell-a"]).l).toBeCloseTo(0.78, 1);
	});
});

describe("petPaletteVars — edge cases", () => {
	test("near-neutral accent still tints (chroma floor)", () => {
		const v = petPaletteVars(MONO_DARK, "dark");
		const goldA = oklchChannels(v["gui-pet-gold-a"]);
		// Floor C0=0.055 → tint chroma 0.055*1.1+0.02 ≈ 0.0805, well above
		// the raw 0.005 — the mono orb reads tinted, not grey.
		expect(goldA.c).toBeCloseTo(0.0805, 2);
	});

	test("rim and glow carry their translucent alphas", () => {
		const dark = petPaletteVars(GOLD_DARK, "dark");
		expect(chroma(dark["gui-pet-rim"]).alpha()).toBeCloseTo(0.3, 3);
		expect(chroma(dark["gui-pet-glow"]).alpha()).toBeCloseTo(0.8, 3);
		const light = petPaletteVars(GOLD_DARK, "light");
		expect(chroma(light["gui-pet-rim"]).alpha()).toBeCloseTo(0.22, 3);
		expect(chroma(light["gui-pet-glow"]).alpha()).toBeCloseTo(0.55, 3);
	});

	test("throws on an unparseable accent (callers keep SVG fallbacks)", () => {
		expect(() => petPaletteVars("not-a-color", "dark")).toThrow();
	});

	test("accepts hex accents too (any format chroma parses)", () => {
		const v = petPaletteVars("#d9a83f", "dark");
		// Derivation keeps the accent hue exactly — the written oklch string
		// carries it verbatim.
		expect(hueDist(oklchChannels(v["gui-pet-gold-a"]).h, accentChannels("#d9a83f").h)).toBeLessThan(0.1);
	});
});
