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
 * Ported (2026-09-28, activity-fold scroll fix): the virtualizer measure
 * compensation GATE (`shouldAdjustVirtualizerForItemSizeChange`) — the
 * decision of WHEN a measured size change may write the height delta back
 * into scrollTop. A blanket disable breaks anchoring for folds animating
 * above the viewport (the reading position is pushed away frame by frame);
 * a blanket enable double-compensates prepends (the caller's key-based
 * anchor restore owns that window). The gate below is the conditional
 * compromise. NOT ported: `prependScrollAdjustment` — prepends are owned by
 * the caller's key-based anchor restore plus a short suppression window
 * (see Transcript.tsx), not by scrollTop arithmetic here.
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

/** "Back to bottom" affordance visibility (exported so the state and its
 *  consumer stay in lockstep).
 *
 *  `following` alone is INTENT, not geometry: a wheel-up over a pane whose
 *  content already fits releases intent synchronously without any scroll
 *  event ever re-adjudicating it, and a fold collapse can afterwards shrink
 *  the content below the viewport — either way the button would linger over
 *  a pane that cannot scroll (user: 折叠后按钮仍显示). The caller therefore
 *  ALSO passes live geometry: the pane must actually be scrolled away from
 *  the bottom (which is only possible when the content overflows). */
export function shouldShowBackToBottom(following: boolean, rowCount: number, scrolledAwayFromBottom: boolean): boolean {
	return !following && rowCount > 0 && scrolledAwayFromBottom;
}

/** Session switch / first bind: start following (land on the latest). */
export function initialFollowing(): boolean {
	return true;
}

/**
 * Virtualizer measure-compensation gate (ZCode `timelineScrollAnchor`
 * parity). Decides whether a measured size change of ONE item may be
 * compensated by writing the height delta back into scrollTop.
 *
 * Rules, in order:
 * - suppressed (prepend window): the caller's key-based anchor restore owns
 *   anchoring — a second compensation source would shift the landing twice;
 * - following: the stick-to-bottom pin owns the tail — compensating would
 *   fight it (and mid-animation scrollTop regressions must not read as
 *   upscrolls);
 * - content width changing: batched re-measure jitter — settle first;
 * - otherwise compensate ONLY when the changed item ends at or above the
 *   current scrollTop, i.e. the entire change happened off-viewport above
 *   the reading position. A partially visible item is never compensated:
 *   the user is looking at it.
 */
export function shouldAdjustVirtualizerForItemSizeChange(input: {
	/** Prepend/restore compensation window is active. */
	suppressAdjustment: boolean;
	following: boolean;
	contentWidthChanging: boolean;
	/** Bottom edge (start + size) of the changed item. */
	itemEnd: number;
	/** Current scroller scrollTop. */
	scrollTop: number;
}): boolean {
	if (input.suppressAdjustment) return false;
	if (input.following) return false;
	if (input.contentWidthChanging) return false;
	return input.itemEnd <= input.scrollTop;
}

/** Minimal slice of the virtualizer item the gate closure needs. */
export interface SizeChangeItem {
	end: number;
}

/**
 * Live-deps closure wiring the gate into the virtualizer
 * (`shouldAdjustScrollPositionOnItemSizeChange`). The deps are read at
 * CALL time — measurements arrive per frame via ResizeObserver, long after
 * the render that created the closure.
 */
export function createShouldAdjustForItemSizeChange(deps: {
	isFollowing: () => boolean;
	isSuppressed: () => boolean;
	getScrollTop: () => number;
}): (item: SizeChangeItem) => boolean {
	return item =>
		shouldAdjustVirtualizerForItemSizeChange({
			suppressAdjustment: deps.isSuppressed(),
			following: deps.isFollowing(),
			contentWidthChanging: false,
			itemEnd: item.end,
			scrollTop: deps.getScrollTop(),
		});
}
