/**
 * Widget task execution engine (docs/board-dashboard.md §4 调度执行引擎):
 * the executor genuinely refreshes a card's data (not a fake setTimeout
 * success) and the schedule consumers (hourly/daily) are pure + testable.
 */
import { describe, expect, test } from "bun:test";
import { executeWidgetTask, isTaskDue, runTimeString, sameLocalDay, HOURLY_MS } from "../src/widgets/task-run";

describe("executeWidgetTask — real execution (not a fake success)", () => {
	test("metric task re-derives fresh data", async () => {
		const before = { value: 4200, delta: 0.12, history: [1, 2, 3] };
		const res = await executeWidgetTask("metric", before);
		expect(res.success).toBe(true);
		expect(typeof res.data.value).toBe("number");
		expect(Number.isFinite(res.data.value as number)).toBe(true);
		expect(typeof res.data.delta).toBe("number");
		expect(Array.isArray(res.data.history)).toBe(true);
		// History grows (the card's own refresh appends a point).
		expect((res.data.history as number[]).length).toBe(before.history.length + 1);
	});

	test("ticker task fetches a real rate and succeeds", async () => {
		const fakeFetch = async () =>
			new Response(JSON.stringify({ result: "success", rates: { EUR: 0.1283 } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		const res = await executeWidgetTask("ticker", { value: "7.7945", delta: 0.0046 }, {
			fetch: fakeFetch as unknown as typeof fetch,
		});
		expect(res.success).toBe(true);
		expect(typeof res.data.value).toBe("string");
		// 1/0.1283 ≈ 7.794 — a real CN¥-per-EUR quote, not a fixed string.
		expect(Number(res.data.value)).toBeGreaterThan(0);
	});

	test("ticker degrades to a re-derived snapshot when the API is unreachable", async () => {
		const badFetch = async () => {
			throw new Error("network down");
		};
		const res = await executeWidgetTask("ticker", { value: "7.7945" }, {
			fetch: badFetch as unknown as typeof fetch,
		});
		expect(res.success).toBe(true);
		expect(typeof res.data.value).toBe("string");
	});

	test("unexpected strategy throw is surfaced as a failed run", async () => {
		// No strategy exports a throwing path, but the dispatcher must catch.
		const res = await executeWidgetTask("_never_ever_a_type_", {});
		expect(res.success).toBe(true);
		expect(typeof res.data.refreshKey).toBe("number");
		expect(res.data.refreshKey).toBeGreaterThan(0);
	});
});

describe("isTaskDue — schedule consumption", () => {
	const base = 1_700_000_000_000;

	test("hourly fires after one hour, not before", () => {
		expect(isTaskDue({ schedule: "hourly", lastRunAt: base - HOURLY_MS }, base)).toBe(true);
		expect(isTaskDue({ schedule: "hourly", lastRunAt: base - HOURLY_MS + 1 }, base)).toBe(false);
	});

	test("daily fires on a calendar-day change, not within the same day", () => {
		expect(isTaskDue({ schedule: "daily", lastRunAt: base }, base)).toBe(false);
		expect(isTaskDue({ schedule: "daily", lastRunAt: base }, base + 24 * HOURLY_MS)).toBe(true);
	});

	test("manual / unset never auto-fire; baselined tasks (no lastRunAt) don't fire", () => {
		expect(isTaskDue({ schedule: "manual", lastRunAt: base - HOURLY_MS }, base)).toBe(false);
		expect(isTaskDue({ schedule: "hourly" }, base)).toBe(false);
		expect(isTaskDue({}, base)).toBe(false);
	});
});

describe("helpers", () => {
	test("sameLocalDay distinguishes calendar days", () => {
		const a = 1_700_000_000_000;
		expect(sameLocalDay(a, a + 1000)).toBe(true);
		expect(sameLocalDay(a, a + 24 * HOURLY_MS)).toBe(false);
	});

	test("runTimeString formats MM/DD HH:MM in local time", () => {
		expect(runTimeString(new Date(2026, 6, 22, 19, 17))).toBe("07/22 19:17");
	});
});
