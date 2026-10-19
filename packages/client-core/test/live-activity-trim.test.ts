import { describe, expect, test } from "bun:test";
import { LIVE_ACTIVITY_ROWS_UNLIMITED, planLiveActivityTrim } from "../src/components/transcript/round-collapse";

/**
 * Running-turn tail trim (display.liveActivityRows).
 *
 * A turn that runs for minutes streams a row per tool call, so the transcript
 * scrolls away from the work. Trimming to the latest rows holds the tail still
 * while the count keeps the earlier ones accounted for.
 *
 * The contract that matters is which rows are dropped: only WORK rows in the
 * in-flight span, and never more than there are. Off by default — a running
 * turn stays fully expanded unless the user asks otherwise, because watching
 * the agent work is the transcript.
 */

describe("planLiveActivityTrim", () => {
	test("is off by default — a short running turn stays fully expanded", () => {
		expect(LIVE_ACTIVITY_ROWS_UNLIMITED).toBe(0);
		expect(planLiveActivityTrim([1, 2, 3, 4, 5], LIVE_ACTIVITY_ROWS_UNLIMITED)).toBeNull();
	});

	test("keeps the tail and counts what it dropped", () => {
		const trim = planLiveActivityTrim([10, 11, 12, 13, 14, 15, 16, 17, 18, 19], 7);
		// 10 rows, 7 visible → the first 3 fold behind the count.
		expect(trim).toEqual({ firstVisibleIdx: 13, hiddenCount: 3 });
	});

	test("does nothing when the rows already fit", () => {
		// Trimming to a count equal to (or above) the row count would add a
		// "+0 more" line and hide nothing.
		expect(planLiveActivityTrim([1, 2, 3], 3)).toBeNull();
		expect(planLiveActivityTrim([1, 2, 3], 10)).toBeNull();
	});

	test("holds the newest row when asked for one", () => {
		// The strictest setting: a reader watching only the current step.
		expect(planLiveActivityTrim([5, 6, 7, 8], 1)).toEqual({ firstVisibleIdx: 8, hiddenCount: 3 });
	});

	test("treats a negative setting as off rather than hiding everything", () => {
		// A hand-edited config must not blank the transcript.
		expect(planLiveActivityTrim([1, 2, 3], -1)).toBeNull();
	});

	test("an empty span never produces a dangling first row", () => {
		expect(planLiveActivityTrim([], 7)).toBeNull();
	});
});
