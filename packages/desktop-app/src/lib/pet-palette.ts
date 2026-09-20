/**
 * Pet palette derivation — the orb follows the app's accent.
 *
 * The builtin mascot used to be hardcoded graphite-shell + brand-gold
 * (the `--gui-pet-shell-*` / `--gui-pet-gold-*` CSS variable fallbacks).
 * That pairing only worked under the default gold accent: under ocean
 * (blue) the gold ring + gold eyes on the cold dark ball read as three
 * unrelated colors stuck together. The SVG already reads every paint
 * from CSS variables, so theming is a matter of computing the palette
 * — six shell/light variables plus the rim light, the hover eye glow and
 * the white face pair — from the
 * LIVE accent token (`--accent`, resolved from tokens.css for the
 * active data-accent × data-theme pair).
 *
 * Derivation (H = accent hue, L0/C0 = accent lightness/chroma):
 *   shell  — the sphere stays a "metal" surface: accent-hued but heavily
 *            desaturated, running dark (dark theme) or mid (light theme)
 *            so the emissive face keeps its contrast.
 *   gold-* — the "light" family (ring, antenna, bounce, thrust):
 *            a bright tint above the accent, the accent itself, and a
 *            deep shade below it. Under the default brand accent this
 *            lands within a hair of the old hardcoded golds, so the
 *            mascot keeps its identity — other accents inherit a whole
 *            coherent orb for free.
 *
 * The face (eyes + mouth) is WHITE, not accent-tinted (2026-09-20, user
 * request). It used to ride `--gui-pet-gold-a/b`, which meant a themed orb
 * whose face changed colour with the theme — on ocean the eyes went blue
 * on a blue-ish ball and the face stopped separating from the shell. White
 * keeps the single legibility rule the mascot needs: the brightest thing
 * on the orb is always the face, whatever the accent is doing. The ring
 * still carries the accent, so the theme is still legible at a glance.
 *
 * The error face keeps `--color-danger` (the one red on the mascot);
 * the white speculars (gloss/sweep) stay neutral by design.
 *
 * Color-pipeline notes:
 *   - chroma.js parses the accent token into oklch channels ONLY. Its
 *     color objects are RGB-backed, so building colors through them
 *     clamps to sRGB at construction time and rotates the hue of the
 *     bright tints this palette emits. The derivation itself is pure
 *     channel arithmetic in oklch (no color-space conversion), which
 *     is also why the output below is hand-formatted.
 *   - Values ship as `oklch()` strings, not hex: bright tints of a
 *     saturated accent sit outside sRGB, and the renderer's Chromium
 *     gamut-maps out-of-gamut oklch properly, preserving hue and
 *     lightness while reducing chroma.
 */

import chroma from "chroma-js";

export interface PetPaletteVars {
	"gui-pet-shell-a": string;
	"gui-pet-shell-b": string;
	"gui-pet-shell-c": string;
	"gui-pet-gold-a": string;
	"gui-pet-gold-b": string;
	"gui-pet-gold-c": string;
	"gui-pet-rim": string;
	"gui-pet-glow": string;
	/** Face light (eyes + mouth). Always near-white; the value only lifts
	 *  with the scheme so it stays "the brightest thing on the orb" on a
	 *  pale light-theme shell too. */
	"gui-pet-face": string;
	/** Face halo colour, used for the eye/mouth drop-shadow. Neutral white
	 *  rather than a tint, so the glow never re-colours the white face. */
	"gui-pet-face-glow": string;
}

const PET_PALETTE_VAR_PREFIX = "--gui-pet-";

/** Serialize one palette color as an `oklch()` string (browser gamut-
 *  maps out-of-gamut values; see the pipeline notes above). */
function fmt(l: number, c: number, h: number, alpha?: number): string {
	const base = `oklch(${(Math.min(1, Math.max(0, l)) * 100).toFixed(2)}% ${Math.min(0.37, Math.max(0, c)).toFixed(4)} ${(((h % 360) + 360) % 360).toFixed(2)}deg`;
	return alpha === undefined ? `${base})` : `${base} / ${alpha})`;
}

/**
 * Derive the ten pet variables from an accent color string (any CSS
 * format chroma can parse — tokens.css ships `oklch(L C H)`) and the
 * active scheme. Throws only when the accent is unparseable; callers
 * should fall back to the SVG's hardcoded defaults.
 */
export function petPaletteVars(accent: string, theme: "light" | "dark"): PetPaletteVars {
	const a = chroma(accent.trim());
	const h = a.get("oklch.h");
	const l0 = a.get("oklch.l");
	// Floor the chroma the "light" family works from so near-neutral
	// accents (mono: C 0.005) still tint the shell instead of greying out.
	const c0 = Math.max(0.055, a.get("oklch.c"));

	if (theme === "dark") {
		// Sphere: accent-hued graphite — dark, barely chromatic.
		// Light family: bright tint → accent → deep shade.
		return {
			"gui-pet-shell-a": fmt(0.56, 0.045, h),
			"gui-pet-shell-b": fmt(0.36, 0.05, h),
			"gui-pet-shell-c": fmt(0.19, 0.045, h),
			"gui-pet-gold-a": fmt(Math.min(0.88, l0 + 0.12), Math.min(0.14, c0 * 1.1 + 0.02), h),
			"gui-pet-gold-b": fmt(l0, c0, h),
			"gui-pet-gold-c": fmt(l0 * 0.62, c0 * 0.9, h),
			// Rim: a cool-to-accent edge light — a light tint of the accent,
			// transparent enough to read as light on the sphere's limb.
			"gui-pet-rim": fmt(Math.min(0.88, l0 + 0.12), Math.min(0.14, c0 * 1.1 + 0.02), h, 0.3),
			"gui-pet-glow": fmt(l0, c0, h, 0.8),
			// Face: near-white, hair of warmth so it reads as a light rather
			// than a cut-out. Neutral halo (no hue) keeps the glow from
			// tinting the white.
			"gui-pet-face": "oklch(0.985 0.004 90)",
			"gui-pet-face-glow": "oklch(1 0 0 / 0.72)",
		};
	}

	// Light scheme: the ball lifts toward the background and the light
	// family deepens so eyes/ring keep their contrast on the pale shell.
	// The face stays white but the halo must carry the separation instead
	// (a white face on a pale shell needs its own dark-agnostic glow), so
	// the glow drops to a soft neutral with more alpha.
	return {
		"gui-pet-shell-a": fmt(0.78, 0.035, h),
		"gui-pet-shell-b": fmt(0.58, 0.045, h),
		"gui-pet-shell-c": fmt(0.38, 0.05, h),
		"gui-pet-gold-a": fmt(Math.min(0.8, l0 + 0.15), Math.min(0.14, c0 * 1.1 + 0.02), h),
		"gui-pet-gold-b": fmt(l0, c0, h),
		"gui-pet-gold-c": fmt(Math.max(0.3, l0 - 0.18), c0 * 0.95, h),
		"gui-pet-rim": fmt(0.3, Math.min(0.1, c0), h, 0.22),
		"gui-pet-glow": fmt(Math.max(0.3, l0 - 0.18), c0 * 0.95, h, 0.55),
		// Face on a light shell: keep it white (the identity rule) and let
		// the halo do the separating — a dark neutral ring around the eye
		// would fight the mouth stroke, so only the alpha changes.
		"gui-pet-face": "oklch(0.99 0.002 90)",
		"gui-pet-face-glow": "oklch(1 0 0 / 0.85)",
	};
}

/** Resolve the live accent token of a document root ("#rrggbb" or worse
 *  when absent → null so the caller keeps the CSS fallbacks). */
export function resolvedAccent(root: HTMLElement): string | null {
	try {
		const v = getComputedStyle(root).getPropertyValue("--accent").trim();
		return v || null;
	} catch {
		return null;
	}
}

/** Current scheme of a document root (pet + main windows both carry
 *  data-theme on <html>; dark is the default when absent). */
export function resolvedTheme(root: HTMLElement): "light" | "dark" {
	return root.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Compute + apply the palette onto a document root. No-op (keeps the
 * SVG fallbacks) when the accent cannot be resolved. Returns true when
 * variables were written.
 */
export function applyPetPalette(root: HTMLElement): boolean {
	const accent = resolvedAccent(root);
	if (!accent) return false;
	try {
		const vars = petPaletteVars(accent, resolvedTheme(root));
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(PET_PALETTE_VAR_PREFIX + name, value);
		}
		return true;
	} catch {
		// Unparseable accent — keep the hardcoded fallbacks.
		return false;
	}
}
