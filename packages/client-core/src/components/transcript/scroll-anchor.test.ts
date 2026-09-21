import { describe, expect, test } from "bun:test";
import {
	anchorActionAfterContentChange,
	BOTTOM_ANCHOR_EPSILON_PX,
	distanceToBottom,
	initialFollowing,
	isAtBottom,
	reconcileFollowingForContentAnchor,
	resolveFollowingAfterScroll,
	shouldShowBackToBottom,
	type TimelineScrollMetrics,
	timelineKeyboardScrollIntent,
	timelineTouchScrollIntent,
	timelineWheelScrollIntent,
} from "./scroll-anchor";

function metrics(scrollTop: number, viewportHeight = 800, contentHeight = 2000): TimelineScrollMetrics {
	return { scrollTop, viewportHeight, contentHeight };
}

describe("distanceToBottom / isAtBottom", () => {
	test("full distance when scrolled to the top", () => {
		expect(distanceToBottom(metrics(0))).toBe(1200);
		expect(isAtBottom(metrics(0))).toBe(false);
	});

	test("zero when content fits the pane", () => {
		expect(distanceToBottom(metrics(0, 800, 500))).toBe(0);
		expect(isAtBottom(metrics(0, 800, 500))).toBe(true);
	});

	test("within epsilon counts as bottom", () => {
		expect(isAtBottom(metrics(1200 - BOTTOM_ANCHOR_EPSILON_PX + 1))).toBe(true);
		expect(isAtBottom(metrics(1200 - BOTTOM_ANCHOR_EPSILON_PX - 1))).toBe(false);
	});
});

describe("resolveFollowingAfterScroll", () => {
	test("user scroll away from bottom releases following", () => {
		expect(resolveFollowingAfterScroll({ following: true, metrics: metrics(0), source: "user" })).toBe(false);
	});

	test("user scroll back to the bottom resumes following", () => {
		expect(resolveFollowingAfterScroll({ following: false, metrics: metrics(1195), source: "user" })).toBe(true);
	});

	test("programmatic stick-to-bottom cannot flip a released intent", () => {
		expect(resolveFollowingAfterScroll({ following: false, metrics: metrics(1195), source: "programmatic" })).toBe(
			false,
		);
	});

	test("layout-driven scroll keeps the current state either way", () => {
		expect(resolveFollowingAfterScroll({ following: true, metrics: metrics(0), source: "layout" })).toBe(true);
		expect(resolveFollowingAfterScroll({ following: false, metrics: metrics(1195), source: "layout" })).toBe(false);
	});
});

describe("anchorActionAfterContentChange", () => {
	test("following sticks to the bottom on growth", () => {
		expect(anchorActionAfterContentChange(true)).toBe("stickToBottom");
	});

	test("released holds the reading position — never pulls back", () => {
		expect(anchorActionAfterContentChange(false)).toBe("hold");
	});

	test("width change holds even while following (batched re-measure jitter)", () => {
		expect(anchorActionAfterContentChange(true, true)).toBe("hold");
	});
});

describe("reconcileFollowingForContentAnchor", () => {
	test("an away intent one frame ahead of its scroll event releases immediately", () => {
		// The classic swallowed-scroll case: user wheels up, and a streaming
		// commit lands before the scroll event fires. Without the reconcile,
		// the stale following=true would stick to the bottom and the upscroll
		// would be swallowed.
		expect(
			reconcileFollowingForContentAnchor({
				following: true,
				metrics: metrics(1190), // still at the bottom right now
				lastObservedScrollTop: 1190,
				userScrollIntent: "awayFromBottom",
			}),
		).toBe(false);
	});

	test("no user input keeps the state (fold/layout scrollTop regressions are not upscrolls)", () => {
		expect(
			reconcileFollowingForContentAnchor({
				following: true,
				metrics: metrics(400),
				lastObservedScrollTop: 400,
				userScrollIntent: "none",
			}),
		).toBe(true);
	});

	test("toward intent at the bottom resumes following", () => {
		expect(
			reconcileFollowingForContentAnchor({
				following: false,
				metrics: metrics(1190),
				lastObservedScrollTop: 700,
				userScrollIntent: "towardBottom",
			}),
		).toBe(true);
	});

	test("unobserved scrollTop regression with unknown intent releases", () => {
		// Programmatic write or test-driven scrollTop the scroll event hasn't
		// accounted yet: a clear regression means the user (or a jump) moved
		// UP — don't re-follow just because content is being appended.
		expect(
			reconcileFollowingForContentAnchor({
				following: true,
				metrics: metrics(200),
				lastObservedScrollTop: 900,
				userScrollIntent: "unknown",
			}),
		).toBe(false);
	});

	test("sub-pixel regression is jitter, not an upscroll", () => {
		expect(
			reconcileFollowingForContentAnchor({
				following: true,
				metrics: metrics(899.5),
				lastObservedScrollTop: 900,
				userScrollIntent: "unknown",
			}),
		).toBe(true);
	});

	test("defaults to unknown intent and keeps state when nothing regressed", () => {
		expect(
			reconcileFollowingForContentAnchor({
				following: false,
				metrics: metrics(900),
				lastObservedScrollTop: 900,
			}),
		).toBe(false);
	});
});

describe("scroll intent classifiers", () => {
	test("wheel deltaY sign maps to intent", () => {
		expect(timelineWheelScrollIntent(-3)).toBe("awayFromBottom");
		expect(timelineWheelScrollIntent(3)).toBe("towardBottom");
		expect(timelineWheelScrollIntent(0)).toBe("none");
	});

	test("touch finger motion is inverse to scrollTop", () => {
		expect(timelineTouchScrollIntent(300, 340)).toBe("awayFromBottom");
		expect(timelineTouchScrollIntent(340, 300)).toBe("towardBottom");
		expect(timelineTouchScrollIntent(300, 300)).toBe("none");
	});

	test("keyboard: up-ish keys away, down-ish toward, space shift-aware", () => {
		expect(timelineKeyboardScrollIntent({ key: "PageUp", shiftKey: false, editableTarget: false })).toBe(
			"awayFromBottom",
		);
		expect(timelineKeyboardScrollIntent({ key: "End", shiftKey: false, editableTarget: false })).toBe("towardBottom");
		expect(timelineKeyboardScrollIntent({ key: " ", shiftKey: true, editableTarget: false })).toBe("awayFromBottom");
		expect(timelineKeyboardScrollIntent({ key: " ", shiftKey: false, editableTarget: false })).toBe("towardBottom");
	});

	test("keyboard: cursor keys inside an editable target are not timeline scrolls", () => {
		expect(timelineKeyboardScrollIntent({ key: "ArrowUp", shiftKey: false, editableTarget: true })).toBe("none");
	});

	test("keyboard: unrelated keys carry no intent", () => {
		expect(timelineKeyboardScrollIntent({ key: "a", shiftKey: false, editableTarget: false })).toBe("none");
	});
});

describe("affordance helpers", () => {
	test("back-to-bottom only when released and rows exist (UI pending review)", () => {
		expect(shouldShowBackToBottom(false, 10)).toBe(true);
		expect(shouldShowBackToBottom(true, 10)).toBe(false);
		expect(shouldShowBackToBottom(false, 0)).toBe(false);
	});

	test("a fresh bind starts following (lands on the latest)", () => {
		expect(initialFollowing()).toBe(true);
	});
});
