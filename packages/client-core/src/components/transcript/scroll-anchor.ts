/**
 * Timeline bottom-anchor state machine (ZCode `timelineScrollAnchor` parity,
 * ported 2026-09-21 as M1.3). Pure functions, no DOM/React.
 *
 * Semantics: `following` expresses the user's scrolling intent, not a
 * transient geometry snapshot. Only genuine user scroll input may flip it;
 * programmatic stick-to-bottom writes and layout-driven scroll events only
 * update the geometry ledger. While following, any content growth (new rows,
 * streaming deltas, deferred measurements like images/highlight) re-pins the
 * tail; once released, growth must NEVER pull the reading position back.
 *
 * Deliberately NOT ported: the virtualizer prepend/measure compensation
 * (`prependScrollAdjustment`, `shouldAdjustVirtualizerForItemSizeChange`).
 * Our transcript renders every loaded entry (no virtualization), so prepend
 * compensation is left to the browser's native overflow anchoring.
 */

/** Bottom tolerance: nearer than this counts as "at the bottom". Covers
 *  sub-pixel scroll positions and the last row's padding. */
export const BOTTOM_ANCHOR_EPSILON_PX = 48;

export interface TimelineScrollMetrics {
	/** Scroller scrollTop. */
	scrollTop: number;
	/** Scroller clientHeight. */
	viewportHeight: number;
	/** Content scrollHeight. */
	contentHeight: number;
}

/** Remaining scrollable distance to the bottom (0 when content < one pane). */
export function distanceToBottom(metrics: TimelineScrollMetrics): number {
	return Math.max(0, metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop);
}

export function isAtBottom(metrics: TimelineScrollMetrics, epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX): boolean {
	return distanceToBottom(metrics) <= epsilonPx;
}

function nextFollowingAfterScroll(
	metrics: TimelineScrollMetrics,
	epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
	return isAtBottom(metrics, epsilonPx);
}

export type TimelineScrollEventSource = "user" | "programmatic" | "layout";

/**
 * Scroll-event adjudication: layout/programmatic scrolls must not change
 * user intent; only user input follows the landing position.
 */
export function resolveFollowingAfterScroll(input: {
	following: boolean;
	metrics: TimelineScrollMetrics;
	source: TimelineScrollEventSource;
	epsilonPx?: number;
}): boolean {
	if (input.source !== "user") return input.following;
	return nextFollowingAfterScroll(input.metrics, input.epsilonPx);
}

/** After any content change: following → stick; released → hold (never pull). */
export function anchorActionAfterContentChange(
	following: boolean,
	contentWidthChanging: boolean = false,
): "stickToBottom" | "hold" {
	return following && !contentWidthChanging ? "stickToBottom" : "hold";
}

/** A scrollTop regression smaller than this is sub-pixel jitter, not an
 *  unobserved user upscroll. */
const UNOBSERVED_SCROLL_EPSILON_PX = 2;

export type TimelineUserScrollIntent = "none" | "awayFromBottom" | "towardBottom" | "unknown";

/** Wheel deltaY aligns with scrollTop: negative reads earlier content. */
export function timelineWheelScrollIntent(deltaY: number): TimelineUserScrollIntent {
	if (deltaY < 0) return "awayFromBottom";
	if (deltaY > 0) return "towardBottom";
	return "none";
}

/** Touch finger motion is inverse to scrollTop: finger down reads earlier. */
export function timelineTouchScrollIntent(previousClientY: number, nextClientY: number): TimelineUserScrollIntent {
	if (nextClientY > previousClientY) return "awayFromBottom";
	if (nextClientY < previousClientY) return "towardBottom";
	return "none";
}

/** Keyboard scroll intent; cursor keys inside an editable target don't count. */
export function timelineKeyboardScrollIntent(input: {
	key: string;
	shiftKey: boolean;
	editableTarget: boolean;
}): TimelineUserScrollIntent {
	if (input.editableTarget) return "none";
	if (input.key === "ArrowUp" || input.key === "PageUp" || input.key === "Home") {
		return "awayFromBottom";
	}
	if (input.key === "ArrowDown" || input.key === "PageDown" || input.key === "End") {
		return "towardBottom";
	}
	if (input.key === " ") {
		return input.shiftKey ? "awayFromBottom" : "towardBottom";
	}
	return "none";
}

/**
 * Reconcile user intent against a content commit BEFORE any stick-to-bottom
 * action. The scroll event for a user upscroll fires a frame after the
 * wheel/keydown; a streaming/measurement commit landing in between would
 * otherwise see a stale `following=true` and yank the viewport back to the
 * bottom, swallowing the scroll. Runs with live metrics captured at commit
 * time:
 * 1. explicit away-from-bottom intent → unfollow immediately;
 * 2. no user input → keep `following` (virtualizer/fold scrollTop
 *    regressions are not upscrolls);
 * 3. toward/unknown → at bottom resumes following, a clear scrollTop
 *    regression releases it, otherwise keep.
 */
export function reconcileFollowingForContentAnchor(input: {
	following: boolean;
	metrics: TimelineScrollMetrics;
	/** Last accounted scrollTop (scroll-event read or post-write readback). */
	lastObservedScrollTop: number;
	userScrollIntent?: TimelineUserScrollIntent;
	bottomEpsilonPx?: number;
	scrollEpsilonPx?: number;
}): boolean {
	const userScrollIntent = input.userScrollIntent ?? "unknown";
	if (userScrollIntent === "awayFromBottom") return false;
	if (userScrollIntent === "none") return input.following;
	if (isAtBottom(input.metrics, input.bottomEpsilonPx ?? BOTTOM_ANCHOR_EPSILON_PX)) {
		return true;
	}
	const unobservedUpscroll =
		input.metrics.scrollTop < input.lastObservedScrollTop - (input.scrollEpsilonPx ?? UNOBSERVED_SCROLL_EPSILON_PX);
	if (unobservedUpscroll) return false;
	return input.following;
}

/** "Back to bottom" affordance visibility (UI pending design-doc review;
 *  exported so the state and its consumer stay in lockstep). */
export function shouldShowBackToBottom(following: boolean, rowCount: number): boolean {
	return !following && rowCount > 0;
}

/** Session switch / first bind: start following (land on the latest). */
export function initialFollowing(): boolean {
	return true;
}
