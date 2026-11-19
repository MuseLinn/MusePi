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

import { oneTakeMotion } from "../lib/motion-tokens";

export { motionDisabled } from "../lib/motion-tokens";

export interface FlyOptions {
	/** Fly the box HOME into the source rectangle instead of out of it. */
	reverse?: boolean;
	fill?: FillMode;
}

/**
 * The shared-element flight: one recipe for every FLIP in the app (image
 * lightbox, standalone widget, composer scene swap). Geometry comes from
 * {@link computeMorph}; duration and curve from the one-take tokens.
 * Returns null for a degenerate rect, so callers fall back to their plain fade.
 */
export function flyFrame(
	element: HTMLElement,
	from: MorphRect,
	to: MorphRect,
	options: FlyOptions = {},
): Animation | null {
	const m = computeMorph(from, to);
	if (!m) return null;
	const motion = oneTakeMotion();
	const away = `translate(${m.dx}px, ${m.dy}px) scale(${m.sx}, ${m.sy})`;
	const frames = options.reverse
		? [
				{ transform: "none", transformOrigin: "top left" },
				{ transform: away, transformOrigin: "top left" },
			]
		: [
				{ transform: away, transformOrigin: "top left" },
				{ transform: "none", transformOrigin: "top left" },
			];
	return element.animate(frames, {
		duration: motion.durationMs,
		easing: motion.easing,
		...(options.fill ? { fill: options.fill } : {}),
	});
}
