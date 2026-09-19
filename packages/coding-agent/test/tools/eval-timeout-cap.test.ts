import { describe, expect, test } from "bun:test";
import { clampTimeout, TOOL_TIMEOUTS } from "@musepi/pi-coding-agent/tools/tool-timeouts";

/**
 * Regression for issue #32: the reporter's second ask was "there is no way to
 * shorten the eval kernel's built-in 30s wait". The lever already existed —
 * `tools.maxTimeout` caps the resolved value, including the default-fallback
 * path — but nothing pinned that behaviour, and the setting's own description
 * only said "maximum the agent can set", which reads as irrelevant to someone
 * trying to LOWER a default.
 *
 * The reporter's other premise (a `timeoutMs ?? 30_000` hardcode that ignored
 * the setting) was already stale when filed: `executor-base.ts` no longer
 * hardcodes it, and the eval tool routes its budget through `clampTimeout`.
 * These cases lock that in.
 */

describe("issue #32 — tools.maxTimeout governs the default, not just explicit values", () => {
	test("an omitted eval timeout falls back to the tool default", () => {
		// What the eval tool passes for a blank `timeout` param.
		expect(clampTimeout("eval", TOOL_TIMEOUTS.eval.default, 0)).toBe(30);
	});

	test("a global cap lowers the DEFAULT when the agent omits timeout", () => {
		// This is the user's actual workaround: set tools.maxTimeout = 5 and a
		// model that never passes `timeout` stops waiting 30s per hung cell.
		expect(clampTimeout("eval", TOOL_TIMEOUTS.eval.default, 5)).toBe(5);
		expect(clampTimeout("eval", TOOL_TIMEOUTS.eval.default, 8)).toBe(8);
	});

	test("a global cap also lowers an explicit timeout", () => {
		expect(clampTimeout("eval", 300, 10)).toBe(10);
	});

	test("cap = 0 means no cap (not 'zero seconds')", () => {
		expect(clampTimeout("eval", 120, 0)).toBe(120);
		expect(clampTimeout("eval", TOOL_TIMEOUTS.eval.default, 0)).toBe(30);
	});

	test("negative cap is treated as no cap", () => {
		expect(clampTimeout("eval", 120, -1)).toBe(120);
	});

	test("the per-tool floor still wins over an aggressive cap", () => {
		// eval's min is 1s; a cap below it must not produce a sub-second budget.
		expect(clampTimeout("eval", 30, 0.1)).toBe(TOOL_TIMEOUTS.eval.min);
	});

	test("eval's default and bash's differ by 10x — the gap the report is really about", () => {
		// `bash python -c "..."` gets 300s; the long-lived python kernel gets
		// 30s. Switching the same workload from one to the other silently
		// drops the budget, which reads as "eval hangs then dies". Pinned so
		// a future change to either default is a deliberate, visible decision.
		expect(TOOL_TIMEOUTS.eval.default).toBe(30);
		expect(TOOL_TIMEOUTS.bash.default).toBe(300);
	});
});
