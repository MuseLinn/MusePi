import { describe, expect, test } from "bun:test";
import { cacheHitRate } from "../src/modes/utils/cache-hit";

/**
 * Issue #8 — the GUI had no cache-hit rate at all (only a raw ☍ cacheRead token
 * count in the trajectory inspector). The rate now comes from ONE helper shared
 * by the TUI `cache_hit` segment and the daemon's session.contextUsage, so the
 * desktop app and the terminal cannot disagree.
 *
 * The denominator is the whole prompt: cacheRead + cacheWrite + input. Counting
 * only cached tokens would report ~100% and hide a regression.
 */

describe("cacheHitRate", () => {
	test("hit rate is cacheRead over the whole prompt", () => {
		// 900 hit / (900 + 100 write + 0 uncached) = 90%
		expect(cacheHitRate({ cacheRead: 900, cacheWrite: 100, input: 0 })).toBeCloseTo(90, 6);
	});

	test("uncached input counts as a miss (DeepSeek reports misses as input)", () => {
		// 500 hit / (500 + 0 write + 500 input) = 50%
		expect(cacheHitRate({ cacheRead: 500, cacheWrite: 0, input: 500 })).toBeCloseTo(50, 6);
	});

	test("all-cached prompt is 100%", () => {
		expect(cacheHitRate({ cacheRead: 1200, cacheWrite: 0, input: 0 })).toBe(100);
	});

	test("no cache reads means nothing to report (null, not 0%)", () => {
		// A cold session must not advertise a 0% hit rate.
		expect(cacheHitRate({ cacheRead: 0, cacheWrite: 800, input: 200 })).toBeNull();
		expect(cacheHitRate({})).toBeNull();
		expect(cacheHitRate(null)).toBeNull();
		expect(cacheHitRate(undefined)).toBeNull();
	});

	test("a total miss is 0%, which IS reportable", () => {
		expect(cacheHitRate({ cacheRead: 1, cacheWrite: 0, input: 999 })).toBeCloseTo(0.1, 6);
	});

	test("treats missing counters as zero instead of NaN", () => {
		expect(cacheHitRate({ cacheRead: 100 })).toBe(100);
	});
});
