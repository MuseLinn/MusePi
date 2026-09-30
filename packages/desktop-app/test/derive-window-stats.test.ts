import { describe, expect, test } from "bun:test";
import type { SessionEntry, StopReason } from "@musepi/pi-wire";
import {
	billedTotalTokens,
	cacheHitPercent,
	decodeTokensPerSecond,
	deriveWindowStats,
	hasAnyTiming,
	hasTokenActivity,
	type StatsRowProps,
	statsRowPropsEqual,
} from "../src/lib/derive-window-stats";

/** Minimal message-entry factories — the fold reads only these fields. */
function userEntry(id: string, timestamp: number, synthetic = false): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		type: "message",
		message: { role: "user", content: "hi", timestamp, synthetic },
	};
}

function assistantEntry(
	id: string,
	timestamp: number,
	opts: {
		duration?: number;
		ttft?: number;
		output?: number;
		stopReason?: StopReason | "";
		toolCallIds?: string[];
	} = {},
): SessionEntry {
	const { duration, ttft, output = 0, stopReason = "stop", toolCallIds = [] } = opts;
	return {
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		type: "message",
		message: {
			role: "assistant",
			model: "test/model",
			content: [
				...toolCallIds.map(callId => ({ type: "toolCall" as const, id: callId, name: "read", arguments: {} })),
				{ type: "text" as const, text: "ok" },
			],
			usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output, cost: { total: 0 } },
			stopReason: stopReason as StopReason,
			timestamp,
			...(duration !== undefined ? { duration } : {}),
			...(ttft !== undefined ? { ttft } : {}),
		},
	};
}

function toolResultEntry(id: string, toolCallId: string, timestamp: number): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		type: "message",
		message: { role: "toolResult", toolCallId, toolName: "read", content: [], isError: false, timestamp },
	};
}

function usage(over: Partial<NonNullable<StatsRowProps["usage"]>> = {}): NonNullable<StatsRowProps["usage"]> {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, cacheHitRate: null, ...over };
}

describe("deriveWindowStats — visible-window fold", () => {
	test("empty window folds to all-zero", () => {
		expect(deriveWindowStats([])).toEqual({
			turns: 0,
			steps: 0,
			llmMs: 0,
			toolMs: 0,
			ttftMs: 0,
			ttftSteps: 0,
			decodeMs: 0,
			decodeTokens: 0,
		});
	});

	test("pure user-message window counts turns, no steps, and carries no timing", () => {
		const stats = deriveWindowStats([userEntry("u1", 1000), userEntry("u2", 2000)]);
		expect(stats.turns).toBe(2);
		expect(stats.steps).toBe(0);
		expect(hasAnyTiming(stats)).toBe(false);
	});

	test("synthetic user messages do not start a turn", () => {
		const stats = deriveWindowStats([userEntry("u1", 1000), userEntry("u2", 2000, true)]);
		expect(stats.turns).toBe(1);
	});

	test("a streaming assistant entry (no stopReason) is not a step yet", () => {
		const stats = deriveWindowStats([userEntry("u1", 1000), assistantEntry("a1", 2000, { stopReason: "" })]);
		expect(stats.steps).toBe(0);
		expect(stats.turns).toBe(1);
	});

	test("settled steps sum llm time; ttft/decode accumulate only when both figures exist", () => {
		const stats = deriveWindowStats([
			userEntry("u1", 1000),
			assistantEntry("a1", 2000, { duration: 4000, ttft: 1000, output: 300 }),
			assistantEntry("a2", 8000, { duration: 2000, ttft: 500, output: 100 }),
			// duration without ttft: llm time counts, decode does not.
			assistantEntry("a3", 12000, { duration: 3000, output: 50 }),
		]);
		expect(stats.steps).toBe(3);
		expect(stats.llmMs).toBe(9000);
		expect(stats.ttftSteps).toBe(2);
		expect(stats.ttftMs).toBe(1500);
		expect(stats.decodeMs).toBe(4500);
		expect(stats.decodeTokens).toBe(400);
		expect(decodeTokensPerSecond(stats)).toBeCloseTo(400 / 4.5, 5);
	});

	test("tool wall time pairs by toolCallId with an in-window host; unpaired results count nothing", () => {
		const stats = deriveWindowStats([
			userEntry("u1", 1000),
			assistantEntry("a1", 2000, { duration: 1000, toolCallIds: ["c1", "c2"] }),
			toolResultEntry("r1", "c1", 5000),
			// c2's result is out of window — no wall time.
			toolResultEntry("r2", "ghost", 9000),
		]);
		expect(stats.toolMs).toBe(3000);
	});

	test("negative tool deltas clamp to zero", () => {
		const stats = deriveWindowStats([
			assistantEntry("a1", 5000, { toolCallIds: ["c1"] }),
			toolResultEntry("r1", "c1", 4000),
		]);
		expect(stats.toolMs).toBe(0);
	});
});

describe("statsRowPropsEqual — streaming memo guard", () => {
	const base: StatsRowProps = {
		stats: deriveWindowStats([userEntry("u1", 1000), assistantEntry("a1", 2000, { duration: 3000, ttft: 500 })]),
		usage: usage({ input: 10, cacheRead: 5, output: 20, cacheHitRate: 33.3 }),
		mode: "detailed",
	};

	test("a stream delta on the unsettled tail leaves the derived props equal (no re-render)", () => {
		const windowWithDelta: SessionEntry[] = [
			userEntry("u1", 1000),
			assistantEntry("a1", 2000, { duration: 3000, ttft: 500 }),
			// The streaming entry: message_update swaps in new text but no
			// stopReason/duration — the fold skips it entirely.
			assistantEntry("a2", 3000, { stopReason: "" }),
		];
		const next: StatsRowProps = { ...base, stats: deriveWindowStats(windowWithDelta) };
		expect(statsRowPropsEqual(base, next)).toBe(true);
	});

	test("a settled step landing changes the props (re-render)", () => {
		const next: StatsRowProps = {
			...base,
			stats: deriveWindowStats([
				userEntry("u1", 1000),
				assistantEntry("a1", 2000, { duration: 3000, ttft: 500 }),
				assistantEntry("a2", 6000, { duration: 1000, ttft: 200 }),
			]),
		};
		expect(statsRowPropsEqual(base, next)).toBe(false);
	});

	test("usage movement (cost/cache) changes the props even when the window is static", () => {
		const next: StatsRowProps = {
			...base,
			usage: usage({ input: 10, cacheRead: 5, output: 20, cacheHitRate: 33.3, cost: 0.01 }),
		};
		expect(statsRowPropsEqual(base, next)).toBe(false);
	});

	test("mode flip always changes the props", () => {
		expect(statsRowPropsEqual(base, { ...base, mode: "compact" })).toBe(false);
	});

	test("null vs fetched usage changes the props", () => {
		expect(statsRowPropsEqual(base, { ...base, usage: null })).toBe(false);
	});
});

describe("usage pill figures", () => {
	test("billedTotalTokens sums the three input buckets plus output", () => {
		expect(billedTotalTokens(usage({ input: 100, cacheRead: 50, cacheWrite: 10, output: 40 }))).toBe(200);
	});

	test("hasTokenActivity gates on any billed token", () => {
		expect(hasTokenActivity(usage())).toBe(false);
		expect(hasTokenActivity(usage({ cacheRead: 1 }))).toBe(true);
		expect(hasTokenActivity(usage({ output: 1 }))).toBe(true);
		expect(hasTokenActivity(null)).toBe(false);
	});

	test("cacheHitPercent follows the projection; null until the first cache read", () => {
		expect(cacheHitPercent(usage({ cacheHitRate: 45.25 }))).toBe("45.3");
		expect(cacheHitPercent(usage())).toBeNull();
	});
});
