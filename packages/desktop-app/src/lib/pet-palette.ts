/**
 * Pet palette derivation — the orb follows the app's accent.
 *
 * The builtin mascot used to be hardcoded graphite-shell + brand-gold
 * (the `--gui-pet-shell-*` / `--gui-pet-gold-*` CSS variable fallbacks).
 * That pairing only worked under the default gold accent: under ocean
 * (blue) the gold ring + gold eyes on the cold dark ball read as three
 * unrelated colors stuck together. The SVG already reads every paint
 * from CSS variables, so theming is a matter of computing the palette
 * — the shell ladder, the light family, the hover eye glow and the
 * white face pair — from the LIVE accent token (`--accent`, resolved
 * from tokens.css for the active data-accent × data-theme pair).
 *
 * Derivation (H = accent hue, L0/C0 = accent lightness/chroma):
 *   shell  — the sphere IS the accent (2026-09-20, user ×3: the old
 *            "accent-hued graphite" shell kept reading as 「黑色球体」 —
 *            dark + barely chromatic is a black ball to the eye no matter
 *            how deliberate the derivation). shell-b is the accent
 *            itself; the lit crown lifts L0 by +0.14 and the base sinks
 *            to 0.55·L0 for volume. BUT 2026-09-21 the user read the
 *            full-chroma ball as 屎黄, not 高级品牌金: saturation is now
 *            scaled DOWN across the whole shell (×0.7–0.8, crown washed
 *            hardest) — the ball stays recognisably gold/champagne while
 *            the theme-hue travel (ocean→blue, jade→green) keeps working
 *            because the chroma SCALAR is hue-independent.
 *   gold-* — the "light" family (ring, accessories), built as a METAL
 *            ramp rather than a tint→shade ladder, now tuned toward
 *            CHAMPAGNE gold (2026-09-21 user: 「高级的品牌金色」):
 *              gold-a  L0+0.18 / C×0.4  — the washed specular, nearly
 *                      white with a warm residue
 *              gold-b  L0+0.06 / C×0.85 — the metal's own body, lifted
 *                      and desaturated vs the old peak-chroma stop
 *              gold-c  L0×0.6  / C×0.6  — the terminator, still holding
 *                      chroma (kept above shell-c, or the ring's far arc
 *                      dissolves into the sphere's own shadow)
 *            Hue deliberately does NOT travel: gold-b IS still the accent,
 *            which is what keeps the theme legible on the ring while the
 *            shell carries it on the body.
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
	"gui-pet-glow": string;
	/** Face light (eyes + mouth). Always near-white; the value only lifts
	 *  with the scheme so it stays "the brightest thing on the orb" on a
	 *  pale light-theme shell too. */
	"gui-pet-face": string;
	/** Face halo colour, used for the eye/mouth drop-shadow. Neutral white
	 *  rather than a tint, so the glow never re-colours the white face. */
	"gui-pet-face-glow": string;
}

// The PetPaletteVars keys already carry the full "gui-pet-…" name — the
// prefix is ONLY the CSS custom-property marker. (Writing
// "--gui-pet-" + "gui-pet-shell-a" produced "--gui-pet-gui-pet-shell-a",
// so every themed palette silently missed the SVG's var(--gui-pet-shell-a)
// reads and the orb never left its hardcoded fallbacks — live-verified
// 2026-09-21 via verify-desktop-pet.mjs.)
const PET_PALETTE_VAR_PREFIX = "--";

/** Serialize one palette color as an `oklch()` string (browser gamut-
 *  maps out-of-gamut values; see the pipeline notes above). */
function fmt(l: number, c: number, h: number, alpha?: number): string {
	const base = `oklch(${(Math.min(1, Math.max(0, l)) * 100).toFixed(2)}% ${Math.min(0.37, Math.max(0, c)).toFixed(4)} ${(((h % 360) + 360) % 360).toFixed(2)}deg`;
	return alpha === undefined ? `${base})` : `${base} / ${alpha})`;
}

/**
 * Derive the nine pet variables from an accent color string (any CSS
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
		// Sphere: the accent hue at CHAMPAGNE saturation — crown washed
		// hardest (specular), mid and base scaled to ~0.7–0.8× accent
		// chroma so the ball reads gold, not tennis-ball (2026-09-21).
		return {
			"gui-pet-shell-a": fmt(Math.min(0.9, l0 + 0.14), Math.min(0.09, c0 * 0.5 + 0.015), h),
			"gui-pet-shell-b": fmt(l0, c0 * 0.8, h),
			"gui-pet-shell-c": fmt(l0 * 0.55, c0 * 0.7, h),
			// Champagne metal ramp: washed specular → lifted desaturated
			// body → chroma-holding terminator (see the derivation note).
			"gui-pet-gold-a": fmt(Math.min(0.93, l0 + 0.18), Math.min(0.07, c0 * 0.4), h),
			"gui-pet-gold-b": fmt(Math.min(0.85, l0 + 0.06), Math.min(0.12, c0 * 0.85), h),
			"gui-pet-gold-c": fmt(Math.max(0.42, l0 * 0.6), c0 * 0.6, h),
			"gui-pet-glow": fmt(l0, c0, h, 0.8),
			// Face: near-white, hair of warmth so it reads as a light rather
			// than a cut-out. Neutral halo (no hue) keeps the glow from
			// tinting the white.
			"gui-pet-face": "oklch(0.985 0.004 90)",
			"gui-pet-face-glow": "oklch(1 0 0 / 0.72)",
		};
	}

	// Light scheme: the ball stays bright with the same champagne
	// desaturation — the accent reads against the pale background without
	// dissolving into it. The ladder lifts so the crown nearly reaches
	// white while the base keeps a deep tone for volume. The face stays
	// white; the halo does the separating, so the glow drops to a soft
	// neutral with more alpha.
	return {
		"gui-pet-shell-a": fmt(Math.min(0.94, l0 + 0.33), Math.min(0.09, c0 * 0.5 + 0.015), h),
		"gui-pet-shell-b": fmt(Math.min(0.82, l0 + 0.12), c0 * 0.8, h),
		"gui-pet-shell-c": fmt(Math.max(0.42, l0 - 0.07), c0 * 0.7, h),
		"gui-pet-gold-a": fmt(Math.min(0.92, l0 + 0.22), Math.min(0.06, c0 * 0.35), h),
		"gui-pet-gold-b": fmt(Math.min(0.85, l0 + 0.05), Math.min(0.12, c0 * 0.8), h),
		"gui-pet-gold-c": fmt(Math.max(0.3, l0 - 0.15), c0 * 0.62, h),
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
	} catch (err) {
		// Unparseable accent — keep the hardcoded fallbacks. NOT silent:
		// theming bugs otherwise surface as "the pet ignores the theme"
		// with nothing in the console to point at.
		console.warn("[pet] palette apply failed:", err);
		return false;
	}
}
