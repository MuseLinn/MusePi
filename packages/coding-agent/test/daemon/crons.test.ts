import { describe, expect, test } from "bun:test";
import {
	type CronTask,
	computeNextRun,
	mergeCronTask,
	nextCronScheduleRuns,
	validateCronSchedule,
	validateCronTask,
} from "../../src/daemon/crons";

function task(partial: Partial<CronTask["schedule"]> & { kind: CronTask["schedule"]["kind"] }): CronTask {
	return {
		id: "t1",
		name: "t",
		enabled: true,
		schedule: partial,
		prompt: "do the thing",
		cwd: "/tmp",
		state: { createdAt: 0 },
	};
}

// Fixed reference time: 2026-08-08 10:00 local.
const FROM = new Date(2026, 7, 8, 10, 0, 0).getTime();

describe("computeNextRun", () => {
	test("daily fires at the next HH:mm", () => {
		const next = computeNextRun(task({ kind: "daily", time: "18:30" }), FROM);
		expect(next).toBe(new Date(2026, 7, 8, 18, 30, 0).getTime());
	});

	test("daily time already passed fires tomorrow", () => {
		const next = computeNextRun(task({ kind: "daily", time: "09:00" }), FROM);
		expect(next).toBe(new Date(2026, 7, 9, 9, 0, 0).getTime());
	});
	test("daily with multiple times fires at the next configured time", () => {
		// 09:00 passed → next fire is 18:30 (FROM = 2026-08-08 10:00).
		const next = computeNextRun(task({ kind: "daily", time: "18:30", times: ["09:00", "18:30"] }), FROM);
		expect(next).toBe(FROM + 8 * 60 * 60 * 1000 + 30 * 60 * 1000);
	});

	test("daily multiple times wraps to tomorrow after the last", () => {
		// All times passed → first time tomorrow.
		const next = computeNextRun(task({ kind: "daily", time: "09:00", times: ["09:00", "10:00"] }), FROM);
		expect(next).toBe(FROM + 23 * 60 * 60 * 1000);
	});

	test("once fires at date+time when in the future", () => {
		const next = computeNextRun(task({ kind: "once", date: "2026-08-09", time: "08:00" }), FROM);
		expect(next).toBe(new Date(2026, 7, 9, 8, 0, 0).getTime());
	});

	test("once in the past never fires again", () => {
		expect(computeNextRun(task({ kind: "once", date: "2026-08-01", time: "08:00" }), FROM)).toBeNull();
	});

	test("weekly picks the next matching weekday (0=Sun .. 6=Sat)", () => {
		// 2026-08-08 is a Saturday (6). Next Sunday (0) at 09:00.
		const next = computeNextRun(task({ kind: "weekly", time: "09:00", weekdays: [0] }), FROM);
		expect(next).toBe(new Date(2026, 7, 9, 9, 0, 0).getTime());
	});

	test("weekly same-day later time fires today", () => {
		const next = computeNextRun(task({ kind: "weekly", time: "23:00", weekdays: [6] }), FROM);
		expect(next).toBe(new Date(2026, 7, 8, 23, 0, 0).getTime());
	});

	test("monthly fires on the day-of-month", () => {
		const next = computeNextRun(task({ kind: "monthly", time: "06:00", dayOfMonth: 15 }), FROM);
		expect(next).toBe(new Date(2026, 7, 15, 6, 0, 0).getTime());
	});

	test("cron every-5-minutes", () => {
		// 10:00:00 is a boundary — next is 10:05.
		const next = computeNextRun(task({ kind: "cron", cron: "*/5 * * * *" }), FROM);
		expect(next).toBe(new Date(2026, 7, 8, 10, 5, 0).getTime());
	});

	test("cron hourly at minute 0", () => {
		const next = computeNextRun(task({ kind: "cron", cron: "0 * * * *" }), FROM);
		expect(next).toBe(new Date(2026, 7, 8, 11, 0, 0).getTime());
	});

	test("cron dom=* is OR-wildcard (Vixie semantics: 0 9 * * 1 runs daily)", () => {
		// dom `*` matches every day, so the dow is OR'd away — next is
		// tomorrow 09:00, not Monday. A true weekday-only schedule needs
		// both dom and dow constrained.
		const next = computeNextRun(task({ kind: "cron", cron: "0 9 * * 1" }), FROM);
		expect(next).toBe(new Date(2026, 7, 9, 9, 0, 0).getTime());
	});

	test("cron with constrained dom+dow (0 9 8-14 * 1) fires on the matching day", () => {
		// dom 8-14 (Aug 8-14) AND dow 1 (Mon) — the AND applies when both
		// are constrained; 2026-08-10 is the first Monday in range.
		const next = computeNextRun(task({ kind: "cron", cron: "0 9 8-14 * 1" }), FROM);
		expect(next).toBe(new Date(2026, 7, 10, 9, 0, 0).getTime());
	});
});

describe("computeNextRun timezone", () => {
	test("daily fires at wall time in the task timezone", () => {
		// 2026-08-08 10:00 Asia/Shanghai = 02:00 UTC → 10:30 Shanghai.
		const from = Date.UTC(2026, 7, 8, 2, 0);
		const next = computeNextRun(task({ kind: "daily", time: "10:30", timezone: "Asia/Shanghai" }), from);
		expect(next).toBe(Date.UTC(2026, 7, 8, 2, 30));
	});

	test("once fires at wall time in the timezone", () => {
		const from = Date.UTC(2026, 7, 8, 0, 0);
		const next = computeNextRun(task({ kind: "once", date: "2026-08-09", time: "08:00", timezone: "UTC" }), from);
		expect(next).toBe(Date.UTC(2026, 7, 9, 8, 0));
	});

	test("weekly resolves weekdays by calendar date in the timezone", () => {
		// Friday 2026-08-07 18:00 Shanghai → next Monday 09:00 Shanghai.
		const from = Date.UTC(2026, 7, 7, 10, 0);
		const next = computeNextRun(
			task({ kind: "weekly", time: "09:00", weekdays: [1], timezone: "Asia/Shanghai" }),
			from,
		);
		expect(next).toBe(Date.UTC(2026, 7, 10, 1, 0));
	});

	test("cron schedules survive a DST transition (America/New_York)", () => {
		// US DST 2026 starts Mar 8: from Mar 7 12:00 UTC (07:00 EST) the
		// next 06:00 local is already EDT (−4) → 10:00 UTC, not 11:00 as a
		// fixed −5 offset would compute.
		const from = Date.UTC(2026, 2, 7, 12, 0);
		const next = computeNextRun(task({ kind: "cron", cron: "0 6 * * *", timezone: "America/New_York" }), from);
		expect(next).toBe(Date.UTC(2026, 2, 8, 10, 0));
	});

	test("unknown timezone falls back to host-local semantics", () => {
		const from = Date.UTC(2026, 7, 8, 2, 0);
		const withTz = computeNextRun(task({ kind: "daily", time: "23:30", timezone: "Not/AZone" }), from);
		const noTz = computeNextRun(task({ kind: "daily", time: "23:30" }), from);
		expect(withTz).toBe(noTz);
	});

	test("idle window defers a due run into the window (crosses midnight)", () => {
		// Raw next = Aug 9 09:00; 09:00 sits in the daytime gap of the
		// 22:00–08:00 window → nearest opening is Aug 8 22:00.
		const next = computeNextRun(
			task({ kind: "daily", time: "09:00", idleWindow: { start: "22:00", end: "08:00" } }),
			FROM,
		);
		expect(next).toBe(new Date(2026, 7, 8, 22, 0, 0).getTime());
	});
});

describe("nextCronScheduleRuns", () => {
	test("expands ascending future runs via the daemon parser", () => {
		const runs = nextCronScheduleRuns({ kind: "cron", cron: "0 */2 * * *" }, Date.UTC(2026, 7, 8, 10, 0), 3);
		expect(runs).toEqual([Date.UTC(2026, 7, 8, 12, 0), Date.UTC(2026, 7, 8, 14, 0), Date.UTC(2026, 7, 8, 16, 0)]);
	});

	test("once never repeats", () => {
		const runs = nextCronScheduleRuns(
			{ kind: "once", date: "2026-08-09", time: "08:00", timezone: "UTC" },
			Date.UTC(2026, 7, 8, 0, 0),
			4,
		);
		expect(runs).toEqual([Date.UTC(2026, 7, 9, 8, 0)]);
	});
});

describe("mergeCronTask", () => {
	const NOW = new Date(2026, 7, 8, 10, 0, 0).getTime();

	test("create keeps the editor's model + thinkingLevel (regression: silently dropped)", () => {
		const t: CronTask = {
			id: "",
			name: "n",
			enabled: true,
			schedule: { kind: "daily", time: "09:00" },
			prompt: "p",
			cwd: "",
			model: "deepseek-v4",
			thinkingLevel: "high",
			state: { createdAt: 0 },
		};
		const merged = mergeCronTask(undefined, t, NOW, "/def");
		expect(merged.model).toBe("deepseek-v4");
		expect(merged.thinkingLevel).toBe("high");
		expect(merged.cwd).toBe("/def");
		expect(merged.id).not.toBe("");
		// enabled ⇒ nextRunAt is recomputed from `now`.
		expect(merged.state.nextRunAt).toBeGreaterThan(NOW);
	});

	test("edit spread-merges and clears nextRunAt when disabled", () => {
		const existing: CronTask = {
			id: "t1",
			name: "old",
			enabled: true,
			schedule: { kind: "daily", time: "09:00" },
			prompt: "p",
			cwd: "/x",
			state: { createdAt: 1, lastStatus: "success" },
		};
		const merged = mergeCronTask(existing, { ...existing, name: "new", enabled: false }, NOW, "/def");
		expect(merged.name).toBe("new");
		expect(merged.state.createdAt).toBe(1);
		expect(merged.state.lastStatus).toBe("success");
		expect(merged.state.nextRunAt).toBeUndefined();
	});
});

describe("validateCronSchedule", () => {
	test("unknown timezone is rejected (the daemon schedules in it)", () => {
		expect(validateCronSchedule({ kind: "daily", time: "09:00", timezone: "Not/AZone" }).ok).toBe(false);
	});

	test("valid IANA timezone passes", () => {
		expect(validateCronSchedule({ kind: "daily", time: "09:00", timezone: "Asia/Shanghai" }).ok).toBe(true);
	});
});

describe("validateCronTask", () => {
	test("valid daily task passes", () => {
		const r = validateCronTask({ name: "x", prompt: "p", schedule: { kind: "daily", time: "09:00" } });
		expect(r.ok).toBe(true);
	});

	test("missing time for daily is rejected", () => {
		const r = validateCronTask({ name: "x", prompt: "p", schedule: { kind: "daily" } });
		expect(r.ok).toBe(false);
	});

	test("missing date for once is rejected", () => {
		const r = validateCronTask({ name: "x", prompt: "p", schedule: { kind: "once", time: "09:00" } });
		expect(r.ok).toBe(false);
	});

	test("missing prompt is rejected", () => {
		const r = validateCronTask({ name: "x", prompt: "", schedule: { kind: "daily", time: "09:00" } });
		expect(r.ok).toBe(false);
	});
});
