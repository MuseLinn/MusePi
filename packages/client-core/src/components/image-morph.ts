/**
 * Lightbox open/close morph math (M1.10 §3.3 一镜到底): the shared-element
 * flight between the source thumbnail rect and the lightbox stage rect,
 * linearized the same way the scene-switch FLIP (`morphFrame` in ChatView)
 * does it — translate + scale from a `top left` transform origin.
 *
 * Kept DOM-free so contract tests can pin the geometry without mounting
 * the lightbox.
 */

export interface MorphRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface MorphTransform {
	dx: number;
	dy: number;
	sx: number;
	sy: number;
}

/**
 * Transform that maps `target` (the element's final layout rect) onto
 * `origin` (the source thumbnail rect), for a `top left` transform origin:
 *
 *   translate(dx, dy) scale(sx, sy)  applied to the target element
 *
 * makes its box coincide with the origin rect. The lightbox renders at its
 * final layout first, then plays this transform reversed (origin → identity)
 * so the image appears to grow out of the thumbnail.
 *
 * Returns `null` for degenerate input (zero/negative/non-finite dimension)
 * so callers can fall back to the plain fade — a zero-sized source cannot
 * be flown from.
 */
export function computeMorph(origin: MorphRect, target: MorphRect): MorphTransform | null {
	for (const r of [origin, target]) {
		if (!Number.isFinite(r.left) || !Number.isFinite(r.top)) return null;
		if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return null;
		if (r.width <= 0 || r.height <= 0) return null;
	}
	return {
		dx: origin.left - target.left,
		dy: origin.top - target.top,
		sx: origin.width / target.width,
		sy: origin.height / target.height,
	};
}

/** WAAPI easing for the entrance flight — `--spring-liquid`'s value
 *  (cubic-bezier(0.34, 1.56, 0.64, 1)); Web Animations cannot resolve the
 *  CSS var, so the token's value is mirrored here (M1.10 §3.1 entrance). */
export const MORPH_EASING_IN = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/** Close flight: no overshoot on the way back (M1.10 §3.1 退出 — ease-in 化
 *  spring, `--spring-snappy` semantics). */
export const MORPH_EASING_OUT = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Scene-morph档 from the M1.10 §3.2 ladder (300-420ms). */
export const MORPH_MS = 360;

/** Motion-off degradation (M1.10 §3.4): the desktop shell's kill-switch
 *  class or the OS reduced-motion preference both collapse the morph to
 *  the plain fade — no intermediate frames may play. */
export function motionDisabled(): boolean {
	if (typeof document === "undefined") return true;
	if (document.documentElement.classList.contains("gui-motion-off")) return true;
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
