import { describe, expect, test } from "bun:test";
import chroma from "chroma-js";
import { applyPetPalette, petPaletteVars } from "../src/lib/pet-palette";

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
	test("returns exactly the nine pet variables", () => {
		const v = petPaletteVars(GOLD_DARK, "dark");
		expect(Object.keys(v).sort()).toEqual(
			[
				"gui-pet-shell-a",
				"gui-pet-shell-b",
				"gui-pet-shell-c",
				"gui-pet-gold-a",
				"gui-pet-gold-b",
				"gui-pet-gold-c",
				"gui-pet-glow",
				"gui-pet-face",
				"gui-pet-face-glow",
			].sort(),
		);
	});

	test("the shell IS the accent hue — champagne-desaturated, hue preserved (dark)", () => {
		// 2026-09-20, user ×3 (「颜色都是黑色球体而不是主题色」/「显示的还是黑色
		// 带点黄」/「现在依然是黑色为底色」): a dark barely-chromatic shell is a
		// black ball to the eye no matter how deliberate the derivation. The
		// contract is now that the ball's BODY rides the accent itself — same
		// lightness and hue, chroma scaled to 0.8× (2026-09-21: full chroma
		// read as 屎黄, not 高级品牌金) — with a lit crown above and a deep
		// base below, hue preserved across the whole sphere.
		const v = petPaletteVars(OCEAN_DARK, "dark");
		const a = accentChannels(OCEAN_DARK);
		const shellB = oklchChannels(v["gui-pet-shell-b"]);
		expect(shellB.l).toBeCloseTo(a.l, 2);
		expect(shellB.c).toBeCloseTo(a.c * 0.8, 2);
		expect(hueDist(shellB.h, a.h)).toBeLessThan(0.1);
		const shellA = oklchChannels(v["gui-pet-shell-a"]);
		const shellC = oklchChannels(v["gui-pet-shell-c"]);
		expect(shellA.l).toBeGreaterThan(a.l);
		expect(shellC.l).toBeLessThan(a.l);
		expect(hueDist(shellA.h, a.h)).toBeLessThan(0.1);
		expect(hueDist(shellC.h, a.h)).toBeLessThan(0.1);
		// The desaturation scalar is hue-independent: every accent gets the
		// same ×0.8 body, so themed accents stay legible.
		expect(oklchChannels(petPaletteVars(GOLD_DARK, "dark")["gui-pet-shell-b"]).c).toBeCloseTo(
			accentChannels(GOLD_DARK).c * 0.8,
			2,
		);
	});

	test("light family is a METAL ramp — non-monotonic chroma on the accent hue", () => {
		// 2026-09-20 user: 「这个黄感觉不是很有高级细腻质感」. The previous
		// contract here was "tint → accent → shade on the accent hue" with
		// chroma falling monotonically alongside lightness — which is exactly
		// how PLASTIC reads: the highlight is just a brighter copy of the same
		// colour, so no surface material survives. Polished metal inverts it
		// (see the derivation notes in pet-palette.ts): the specular washes
		// toward white, the body holds the chroma peak, the terminator keeps
		// a deep residue instead of greying out. 2026-09-21 the ramp was
		// tuned toward CHAMPAGNE gold (user: 「高级的品牌金色」): the body is
		// LIFTED (+0.06) and desaturated (×0.85), the specular nearly white.
		const v = petPaletteVars(GOLD_DARK, "dark");
		const a = accentChannels(GOLD_DARK);
		const goldA = oklchChannels(v["gui-pet-gold-a"]);
		const goldB = oklchChannels(v["gui-pet-gold-b"]);
		const goldC = oklchChannels(v["gui-pet-gold-c"]);
		// Lightness still orders crown → body → terminator, the body lifted
		// above the accent so the ring reads as polished metal, not paint…
		expect(goldA.l).toBeGreaterThan(a.l);
		expect(goldB.l).toBeGreaterThan(a.l);
		expect(goldC.l).toBeLessThan(a.l);
		// …but chroma deliberately does NOT: the peak sits in the BODY, not
		// in the highlight. This is the whole "material" trick.
		expect(goldB.c).toBeGreaterThan(goldA.c);
		expect(goldB.c).toBeGreaterThan(goldC.c);
		expect(goldC.c).toBeGreaterThan(goldA.c);
		// The body is DESATURATED vs the accent (champagne, not tennis ball)…
		expect(goldB.c).toBeLessThan(a.c);
		// …but the shell desaturates harder, so the ring still carries the
		// theme's saturation relative to the ball.
		expect(goldB.c).toBeGreaterThan(oklchChannels(v["gui-pet-shell-b"]).c);
		// Hue never travels: the body IS still the accent, which is what keeps
		// the theme legible on the ring while the shell carries it on the body.
		expect(hueDist(goldA.h, a.h)).toBeLessThan(0.1);
		expect(hueDist(goldB.h, a.h)).toBeLessThan(0.1);
		expect(hueDist(goldC.h, a.h)).toBeLessThan(0.1);
		// The ring's terminator must stay LIGHTER than the shell's own shadow,
		// or the far arc dissolves into the sphere instead of reading as an
		// orbit passing behind the body.
		expect(goldC.l).toBeGreaterThan(oklchChannels(v["gui-pet-shell-c"]).l);
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

	test("light theme lifts the ladder so the ball holds contrast on pale ground", () => {
		const v = petPaletteVars(GOLD_LIGHT, "light");
		const goldC = oklchChannels(v["gui-pet-gold-c"]);
		expect(goldC.l).toBeGreaterThanOrEqual(0.3);
		// The light ball is BRIGHT (the accent reads against a pale
		// background) — the old 0.78 was still a washed-out mid tone.
		expect(oklchChannels(v["gui-pet-shell-a"]).l).toBeCloseTo(0.94, 1);
		// Hue follows the accent on the whole sphere. Compared against the
		// accent's chroma-parsed hue, not the literal: chroma's oklch
		// round-trip drifts the written value by ~0.1° (see the derivation
		// tests above), so a literal comparison is flakier than the contract.
		expect(hueDist(oklchChannels(v["gui-pet-shell-b"]).h, accentChannels(GOLD_LIGHT).h)).toBeLessThan(0.2);
	});
});

describe("petPaletteVars — edge cases", () => {
	test("near-neutral accent still tints (chroma floor)", () => {
		const v = petPaletteVars(MONO_DARK, "dark");
		const GOLD_A = oklchChannels(v["gui-pet-gold-a"]);
		// Floor C0=0.055 → the metal body peaks at ≈0.0468 while the specular
		// sheds most of it (×0.4 ≈ 0.022) — still ~4× the raw 0.005, so the
		// mono orb reads tinted AND metallic rather than grey or plastic.
		expect(GOLD_A.c).toBeCloseTo(0.022, 2);
		expect(oklchChannels(v["gui-pet-gold-b"]).c).toBeGreaterThan(GOLD_A.c);
	});

	test("glow carries its translucent alpha", () => {
		const dark = petPaletteVars(GOLD_DARK, "dark");
		expect(chroma(dark["gui-pet-glow"]).alpha()).toBeCloseTo(0.8, 3);
		const light = petPaletteVars(GOLD_DARK, "light");
		expect(chroma(light["gui-pet-glow"]).alpha()).toBeCloseTo(0.55, 3);
	});

	test("the face is white in EVERY theme and accent (the legibility rule)", () => {
		// The face stopped riding the accent hue on 2026-09-20: a themed face
		// meant ocean's eyes went blue on a blue-ish ball, so the brightest
		// element stopped separating from the shell. The contract is now
		// "near-white, always" — accent-independent by construction.
		//
		// Read via chroma, not the oklch-string helper: the face values are
		// hand-authored literals (`oklch(0.985 0.004 90)`), not `fmt()` output,
		// so they carry neither `%` nor `deg`.
		for (const accent of [GOLD_DARK, GOLD_LIGHT, OCEAN_DARK, MONO_DARK, "#d9a83f"]) {
			for (const theme of ["dark", "light"] as const) {
				const face = chroma(petPaletteVars(accent, theme)["gui-pet-face"]);
				expect(face.get("oklch.l")).toBeGreaterThan(0.98);
				// Effectively neutral: a hair of warmth is allowed (0.004),
				// but never enough to read as a tint.
				expect(face.get("oklch.c")).toBeLessThan(0.01);
			}
		}
	});

	test("the face is always brighter than the shell it sits on", () => {
		// The single rule the mascot needs: the light source is the face. On
		// a bright accent ball the crown highlight may approach the face's
		// lightness, but the face must still out-shine it, and the BODY the
		// face is actually painted on must stay well below it.
		for (const theme of ["dark", "light"] as const) {
			const v = petPaletteVars(OCEAN_DARK, theme);
			const face = chroma(v["gui-pet-face"]).get("oklch.l");
			const shellA = oklchChannels(v["gui-pet-shell-a"]).l;
			const shellB = oklchChannels(v["gui-pet-shell-b"]).l;
			expect(face).toBeGreaterThan(shellA);
			expect(face - shellB).toBeGreaterThan(0.2);
		}
	});

	test("the face halo is neutral white (it must not tint the white face)", () => {
		const dark = petPaletteVars(OCEAN_DARK, "dark");
		const halo = chroma(dark["gui-pet-face-glow"]);
		// chroma's oklch round-trip carries float noise (~4e-5), so assert
		// "effectively neutral" rather than exactly 0.
		expect(halo.get("oklch.c")).toBeLessThan(0.001);
		// Light scheme needs a stronger halo — a white face on a pale shell
		// separates by glow, not by value.
		expect(halo.alpha()).toBeLessThan(chroma(petPaletteVars(OCEAN_DARK, "light")["gui-pet-face-glow"]).alpha());
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

describe("applyPetPalette — the write contract", () => {
	/** Minimal root stand-in: dataset + a capturing style.setProperty.
	 *  resolvedAccent reads --accent through the global getComputedStyle,
	 *  stubbed below for the duration of the test. */
	function fakeRoot(accent: string) {
		const written = new Map<string, string>();
		const root = {
			dataset: { theme: "dark" },
			style: {
				setProperty: (name: string, value: string) => written.set(name, value),
			},
		};
		const g = globalThis as { getComputedStyle?: unknown };
		const prev = g.getComputedStyle;
		g.getComputedStyle = () => ({
			getPropertyValue: (name: string) => (name === "--accent" ? accent : ""),
		});
		return {
			root: root as unknown as Parameters<typeof applyPetPalette>[0],
			written,
			restore: () => {
				if (prev === undefined) delete g.getComputedStyle;
				else g.getComputedStyle = prev;
			},
		};
	}

	test("writes SINGLE-prefixed --gui-pet-* names (regression: the double-prefixed write silently missed every SVG var() read)", () => {
		const { root, written, restore } = fakeRoot(GOLD_DARK);
		try {
			expect(applyPetPalette(root)).toBe(true);
			// The SVG reads var(--gui-pet-shell-a) — that exact name must
			// exist on the root, and the double-prefixed ghost must not.
			expect(written.has("--gui-pet-shell-a")).toBe(true);
			expect(written.has("--gui-pet-gold-b")).toBe(true);
			expect(written.has("--gui-pet-gui-pet-shell-a")).toBe(false);
		} finally {
			restore();
		}
	});

	test("no-op (false, nothing written) when --accent cannot be resolved", () => {
		const { root, written, restore } = fakeRoot("");
		try {
			expect(applyPetPalette(root)).toBe(false);
			expect(written.size).toBe(0);
		} finally {
			restore();
		}
	});
});
