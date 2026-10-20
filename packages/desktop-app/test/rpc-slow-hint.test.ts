/**
 * The slow-hint contract.
 *
 * A request that outruns the caller's patience must not reject: the daemon is
 * often genuinely working (session.create loads the extension set; a model turn
 * sits in provider prep), and a hard timeout turned every slow-but-healthy call
 * into a red "请求失败" banner that a retry immediately fixed. The caller read
 * a spurious failure.
 *
 * What must hold: a fast request never ticks; a slow one reports elapsed time;
 * and NEITHER changes the request's outcome.
 */
import { describe, expect, test } from "bun:test";
import {
	elapsedSeconds,
	RPC_SLOW_HINT_AFTER_MS,
	RPC_SLOW_HINT_INTERVAL_MS,
	withSlowHint,
} from "../src/lib/rpc-slow-hint";

/** Resolve after `ms` (real timers — the ticker uses intervals). */
function delay<T>(value: T, ms: number): Promise<T> {
	return new Promise(resolve => setTimeout(() => resolve(value), ms));
}

describe("withSlowHint", () => {
	test("a fast request never reports a wait", async () => {
		const ticks: number[] = [];
		const value = await withSlowHint(delay("ok", 0), t => ticks.push(t.elapsedMs));
		expect(value).toBe("ok");
		expect(ticks).toEqual([]);
	});

	test("a slow request reports the elapsed time, then keeps ticking", async () => {
		const ticks: number[] = [];
		const value = await withSlowHint(delay("ok", RPC_SLOW_HINT_AFTER_MS + RPC_SLOW_HINT_INTERVAL_MS + 60), t =>
			ticks.push(t.elapsedMs),
		);
		expect(value).toBe("ok");
		// One tick at the threshold, one per interval after it — never one
		// per millisecond, and never zero.
		expect(ticks.length).toBeGreaterThanOrEqual(2);
		// Elapsed is measured from the send, so the first tick is the delay.
		expect(ticks[0]).toBeGreaterThanOrEqual(RPC_SLOW_HINT_AFTER_MS - 50);
		// Ticks advance — a repeated identical number would render a frozen
		// counter, which is the failure this exists to prevent.
		expect(ticks[1]).toBeGreaterThan(ticks[0]!);
	}, 10_000);

	test("the hint never changes a failure outcome", async () => {
		const ticks: number[] = [];
		const boom = new Promise((_, reject) => setTimeout(() => reject(new Error("boom")), RPC_SLOW_HINT_AFTER_MS + 40));
		await expect(withSlowHint(boom, t => ticks.push(t.elapsedMs))).rejects.toThrow("boom");
		// It did report the wait on the way to failing — the point is that the
		// hint is additive, not a substitution.
		expect(ticks.length).toBeGreaterThanOrEqual(1);
	}, 10_000);

	test("no ticker is left running after the request settles", async () => {
		// A leaked interval would keep ticking forever and hold the renderer's
		// timer queue. Awaiting microtasks lets the cleared interval's slot
		// be observable: with no pending work, the process exits cleanly.
		const ticks: number[] = [];
		await withSlowHint(delay("ok", RPC_SLOW_HINT_AFTER_MS + 30), t => ticks.push(t.elapsedMs));
		const seen = ticks.length;
		await new Promise(r => setTimeout(r, RPC_SLOW_HINT_INTERVAL_MS + 60));
		expect(ticks.length).toBe(seen);
	}, 10_000);

	test("elapsed seconds round for display", () => {
		// "3127ms" in a skeleton reads as noise; "3s" reads as progress.
		expect(elapsedSeconds(1_000)).toBe(1);
		expect(elapsedSeconds(2_499)).toBe(2);
		expect(elapsedSeconds(2_500)).toBe(3);
		expect(elapsedSeconds(0)).toBe(1);
	});
});
