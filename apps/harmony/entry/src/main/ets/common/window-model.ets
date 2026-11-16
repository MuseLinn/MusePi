/**
 * Window metrics for the MusePi harmony shell.
 *
 * HarmonyOS decides layout on the *window*, never on the device: one tablet
 * produces three different layouts when it runs full-screen, in split screen
 * or as a free window, and one foldable crosses the phone breakpoint simply by
 * closing. So every branch in this file takes a width/height in vp and no
 * branch takes a device name, a model number or a fold state.
 *
 * The thresholds are the published HarmonyOS breakpoints:
 *   width  xs [0,320) sm [320,600) md [600,840) lg [840,1440) xl [1440,∞)
 *   height flat  h/w < 0.8     square [0.8,1.2)  tall  ≥ 1.2
 * They are constants here rather than `UIContext.getWindowWidthBreakpoint()`
 * for two reasons: that API is 13+ while the install floor is 12, and the
 * chrome also needs the raw vp width to size a rail — a breakpoint name alone
 * cannot tell 600vp from 1439vp.
 */

/** Horizontal breakpoint — how wide the window is. */
export type WidthBreakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Vertical breakpoint — how much *relative* height the window has, by aspect
 * ratio rather than by height value. A phone in landscape and a tablet in
 * landscape are a long way apart in width but share the real problem: not
 * enough height for a bottom bar.
 */
export type HeightBreakpoint = 'flat' | 'square' | 'tall';

/**
 * Where the three destinations live.
 * - `bottom`: the floating tab bar, phone portrait.
 * - `rail`: the left rail, everything else (see `chromeLayoutOf`).
 */
export type ChromeLayout = 'bottom' | 'rail';

/** Foldable form, translated from `display.FoldStatus`. */
export type FoldForm = 'unknown' | 'folded' | 'expanded' | 'half' | 'dual';

/** Everything one layout pass needs, derived in one place. */
export interface WindowMetrics {
	widthVp: number;
	heightVp: number;
	width: WidthBreakpoint;
	height: HeightBreakpoint;
	layout: ChromeLayout;
	railWidth: number;
}

/** System-bar / cutout insets in vp, one value per edge. */
export interface Insets {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

const XS_MAX: number = 320;
const SM_MAX: number = 600;
const MD_MAX: number = 840;
const LG_MAX: number = 1440;

/** Aspect ratio (height / width) at which a window stops being "flat". */
const FLAT_MAX: number = 0.8;
const SQUARE_MAX: number = 1.2;

/**
 * Rail widths. A wide window gets a real sidebar (icon + label + session list),
 * not a fattened icon rail; `md` has no width to spare for labels and stays an
 * icon rail; a flat window is short, so the rail stays narrow.
 */
const RAIL_COMPACT: number = 72;
const RAIL_MD: number = 84;
const RAIL_LG: number = 84;
/** Second column on a wide window: the session list, beside the icon rail. */
export const LIST_PANE: number = 260;
/** Narrower variant used on a foldable's inner screen (`md`). */
export const LIST_PANE_COMPACT: number = 220;

export function widthBreakpointOf(widthVp: number): WidthBreakpoint {
	if (widthVp < XS_MAX) return 'xs';
	if (widthVp < SM_MAX) return 'sm';
	if (widthVp < MD_MAX) return 'md';
	if (widthVp < LG_MAX) return 'lg';
	return 'xl';
}

export function heightBreakpointOf(widthVp: number, heightVp: number): HeightBreakpoint {
	if (!(widthVp > 0) || !(heightVp > 0)) return 'tall';
	const ratio = heightVp / widthVp;
	if (ratio < FLAT_MAX) return 'flat';
	if (ratio < SQUARE_MAX) return 'square';
	return 'tall';
}

/**
 * Bottom bar or rail.
 *
 * A bar costs ~96vp of height and a rail costs 72–96vp of width, so the choice
 * is which dimension is scarcer. A phone portrait (`sm`/`tall`) has height to
 * spare and no width: bar. Every flat window (`flat`) would spend a third of
 * its height on a bar: rail, even when it is only 500vp wide. Anything `md`
 * and up is wide enough that a rail reads as navigation rather than as chrome
 * stolen from the content.
 */
export function chromeLayoutOf(width: WidthBreakpoint, height: HeightBreakpoint): ChromeLayout {
	if (height === 'flat') return 'rail';
	if (width === 'xs' || width === 'sm') return 'bottom';
	return 'rail';
}

/**
 * Width of the session-list column, or 0 when the window has no room for it.
 *
 * A phone (sm and below) has none. A foldable's inner screen often lands in
 * `md` (≈680vp) — too narrow for the 260vp column but wide enough for a 220vp
 * one, and that is exactly the shape where a persistent list earns its keep.
 * The desktop-width column is used from `lg` up.
 */
export function listPaneWidthOf(width: WidthBreakpoint, height: HeightBreakpoint): number {
	if (width === 'lg' || width === 'xl') return LIST_PANE;
	if (width === 'md' && height !== 'flat') return LIST_PANE_COMPACT;
	return 0;
}

/** Narrowest session column a user can drag down to. */
export const PANE_MIN: number = 180;
/**
 * Content floor. The transcript is the point of the screen, so the divider
 * stops before the conversation stops being readable — a dragged column that
 * can eat the content is a resize handle nobody wants.
 */
const CONTENT_MIN: number = 360;

/**
 * Clamp a requested list-column width against the window it has to live in.
 *
 * Called on every drag frame (cheap) and on load (so a width remembered from a
 * wide window cannot crush the list on a narrower one).
 */
export function clampPaneWidth(requested: number, windowVp: number, railWidth: number,
	insetLeft: number, insetRight: number): number {
	const room = windowVp - railWidth - insetLeft - insetRight - CONTENT_MIN;
	const ceiling = Math.max(PANE_MIN, room);
	return Math.round(Math.min(Math.max(requested, PANE_MIN), ceiling));
}

export function railWidthOf(width: WidthBreakpoint, height: HeightBreakpoint): number {
	// Width decides whether labels and a session list fit; the height
	// breakpoint only decides how narrow a *phone-shaped* window must keep its
	// rail. Ordering the other way round turned an unfolded 940×665 window into
	// a 72vp icon rail, because its aspect ratio is "flat" — the sidebar then
	// had no room for anything the wide window had just made possible.
	// The rail is always an icon rail: the wide window gets its session list as
	// a SECOND column (LIST_PANE), not as a fattened rail — that is how the
	// platform's own apps split an unfolded screen, and it keeps the rail's
	// destinations reachable while the list scrolls independently.
	if (height === 'flat') return RAIL_COMPACT;
	if (width === 'md') return RAIL_MD;
	return RAIL_LG;
}

export function metricsOf(widthVp: number, heightVp: number): WindowMetrics {
	const width = widthBreakpointOf(widthVp);
	const height = heightBreakpointOf(widthVp, heightVp);
	return {
		widthVp: widthVp,
		heightVp: heightVp,
		width: width,
		height: height,
		layout: chromeLayoutOf(width, height),
		railWidth: railWidthOf(width, height),
	};
}

/**
 * `display.FoldStatus` → form. Only the three single-hinge values carry a
 * design decision; the dual-axis combinations (11/13/21/22/23, tri-fold and
 * foldable PC) are reported as `dual`, which the chrome deliberately treats by
 * window size — there is no universal answer to "is the second hinge half
 * closed a hover state or a large screen".
 */
export function foldFormOf(status: number): FoldForm {
	switch (status) {
		case 0: return 'unknown';
		case 1: return 'expanded';
		case 2: return 'folded';
		case 3: return 'half';
		default: return 'dual';
	}
}

export function emptyInsets(): Insets {
	return { top: 0, bottom: 0, left: 0, right: 0 };
}

/** Parse the inset JSON published by EntryAbility; malformed input is zero. */
export function parseInsets(json: string): Insets {
	try {
		const parsed: Insets = JSON.parse(json) as Insets;
		return {
			top: typeof parsed.top === 'number' ? parsed.top : 0,
			bottom: typeof parsed.bottom === 'number' ? parsed.bottom : 0,
			left: typeof parsed.left === 'number' ? parsed.left : 0,
			right: typeof parsed.right === 'number' ? parsed.right : 0,
		};
	} catch (e) {
		return emptyInsets();
	}
}
