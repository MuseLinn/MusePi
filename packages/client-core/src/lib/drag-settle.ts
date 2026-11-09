/**
 * Drag-release physics for the mobile shell (comma `docs/DESIGN.md` §6.1:
 * "位移、缩放、旋转、尺寸一律用弹簧…手势松手时，把手指的速度作为弹簧的初始速度").
 *
 * A WebView gives us CSS transitions, not `SpringForce`, so the handoff is
 * modelled rather than integrated: the release velocity decides the outcome
 * first (a quick flick completes even when the finger stopped short of the
 * threshold) and then decides how long the settle takes — a fast release
 * arrives fast, a slow one eases across the remaining distance on the
 * overshoot curve. Position alone only decides when the finger was still.
 *
 * The one rule carried over verbatim: never clamp the interpolation to 0–1.
 * The settle curve overshoots on purpose; clamping would flatten the bounce.
 */

export interface DragSample {
	/** Pointer position along the drag axis, in CSS px. */
	pos: number;
	/** Event timestamp (`event.timeStamp`, ms). */
	t: number;
}

/** Below this the release counts as still (≈50 px/s). */
export const FLICK_VELOCITY = 0.05;
/** A release at or above this reads as an intentional flick (≈650 px/s). */
export const FLICK_THRESHOLD = 0.65;

/** Instantaneous velocity between two samples, in px per ms. */
export function velocityFrom(previous: DragSample | null, current: DragSample): number {
	if (!previous) return 0;
	const dt = current.t - previous.t;
	if (dt <= 0) return 0;
	return (current.pos - previous.pos) / dt;
}

/**
 * Settle duration for a release at `velocity` (px/ms) that still has
 * `distance` px to travel. Bounded so a still release always reads as a
 * deliberate snap and a hard flick never looks like a teleport.
 */
export function settleMs(distance: number, velocity: number): number {
	const speed = Math.abs(velocity);
	if (speed < FLICK_VELOCITY) return 260;
	return Math.round(Math.min(240, Math.max(90, Math.abs(distance) / speed)));
}

/** True when the release was a deliberate flick in `direction` (+1 / -1). */
export function isFlick(velocity: number, direction: 1 | -1): boolean {
	return velocity * direction >= FLICK_THRESHOLD;
}
