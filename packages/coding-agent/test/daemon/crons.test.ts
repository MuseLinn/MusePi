import { describe, expect, test } from "bun:test";
import { computeNextRun, validateCronTask, type CronTask } from "../../src/daemon/crons";

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
