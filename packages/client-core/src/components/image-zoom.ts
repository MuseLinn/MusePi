/**
 * The zoom arithmetic for image previews.
 *
 * Kept apart from the component because the numbers are where the behaviour
 * actually lives: what "fit" means for a small icon, which levels the − and +
 * buttons step through, and how far one wheel notch moves. A component that
 * inlined them would make each of those a rendering decision, and untestable
 * without a browser.
 *
 * The scale is a multiplier on the image's natural size. `null` means "fit" —
 * the scale then follows the viewer's size, and the image is never upscaled, so
 * a 16px icon stays 16px instead of blurring across the panel.
 *
 * Absorbed from openchamber's `views/files/previews/imageZoom.ts`.
 */

/** Space the image keeps from the viewer's edges, in CSS pixels. */
export const IMAGE_VIEWPORT_PADDING = 12;

const MIN_ZOOM_SCALE = 0.1;
const MAX_ZOOM_SCALE = 16;

/** The levels the − and + buttons step through. */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const;

/** A wheel notch is worth this many pixels of delta. */
const WHEEL_LINE_PIXELS = 16;
/** The most one event may move the scale, so a notch never jumps levels. */
const WHEEL_MAX_DELTA = 30;

export interface Size {
	readonly width: number;
	readonly height: number;
}

/**
 * Safari's trackpad-pinch events.
 *
 * Not in the DOM lib: `gesturestart` / `gesturechange` / `gestureend` are
 * WebKit-only, and a `GestureEvent` type is not published for them. Declared
 * here so the listener that uses them can be typed without pretending the
 * events exist everywhere — the code guards on `addEventListener` accepting
 * the name, and Chromium never fires them.
 */
export interface GestureEventLike extends Event {
	readonly scale: number;
	readonly clientX: number;
	readonly clientY: number;
}

/**
 * The scale fit shows the image at: whole inside the viewer, never upscaled.
 */
export function fitImageScale(natural: Size, viewport: Size): number {
	const width = viewport.width - IMAGE_VIEWPORT_PADDING * 2;
	const height = viewport.height - IMAGE_VIEWPORT_PADDING * 2;
	if (natural.width <= 0 || natural.height <= 0 || width <= 0 || height <= 0) return 1;
	return Math.min(1, width / natural.width, height / natural.height);
}

/**
 * Keeps a zoom inside its range.
 *
 * The floor is 10%, or the image's own fit scale when that is smaller — a
 * 20000px screenshot in a small panel fits at 2%, and zooming out past that
 * would show it smaller than it already fits.
 */
export function clampImageScale(scale: number, fitScale: number): number {
	return Math.min(MAX_ZOOM_SCALE, Math.max(Math.min(MIN_ZOOM_SCALE, fitScale), scale));
}

/**
 * The next preset level from the current scale — the way the − and + buttons
 * step, so the scale always lands on a number the readout can show cleanly.
 */
export function stepImageScale(scale: number, direction: 1 | -1): number {
	if (direction === 1) {
		return ZOOM_STEPS.find(step => step > scale * 1.001) ?? MAX_ZOOM_SCALE;
	}
	return [...ZOOM_STEPS].reverse().find(step => step < scale * 0.999) ?? MIN_ZOOM_SCALE;
}

/**
 * The scale factor for one zoom wheel event.
 *
 * A trackpad pinch sends many small deltas, a mouse wheel notch one large one;
 * capping the delta keeps a notch from jumping several levels at once.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaMode === 1 ? deltaY * WHEEL_LINE_PIXELS : deltaY;
	const capped = Math.max(-WHEEL_MAX_DELTA, Math.min(WHEEL_MAX_DELTA, pixels));
	return Math.exp(-capped / 100);
}
