import { describe, expect, it } from "bun:test";
import { ExtensionScheduler } from "./schedule";

/**
 * Session-scoped extension reminders: one-shot and fixed-interval schedules
 * fired through an injected deliver callback. A fake clock (explicit `now`)
 * keeps every case deterministic; no timers, sessions, or daemon involved.
 */
describe("ExtensionScheduler", () => {
	it("rejects missing, multiple, and malformed timings", () => {
		const scheduler = new ExtensionScheduler();
		expect(() => scheduler.create({ prompt: "x" }, 1000)).toThrow(/one of/);
		expect(() => scheduler.create({ prompt: "x", afterSeconds: 1, at: 2 }, 1000)).toThrow(/mutually exclusive/);
		expect(() => scheduler.create({ prompt: "x", afterSeconds: 0 }, 1000)).toThrow(/> 0/);
		expect(() => scheduler.create({ prompt: "x", everySeconds: -5 }, 1000)).toThrow(/> 0/);
		expect(() => scheduler.create({ prompt: "x", at: "not a date" }, 1000)).toThrow(/parseable/);
		expect(() => scheduler.create({ prompt: "" }, 1000)).toThrow(/non-empty/);
	});

	it("fires a one-shot once and consumes it", () => {
		const scheduler = new ExtensionScheduler();
		const delivered: string[] = [];
		const record = scheduler.create({ prompt: "remind me", afterSeconds: 10 }, 1000);
		expect(record.nextAt).toBe(11_000);

		expect(scheduler.drive(10_999, r => delivered.push(r.prompt))).toEqual([]);
		expect(scheduler.drive(11_000, r => delivered.push(r.prompt))).toEqual([record.id]);
		expect(delivered).toEqual(["remind me"]);
		expect(scheduler.list()).toEqual([]);
		// A second drive does not re-fire a consumed one-shot.
		expect(scheduler.drive(12_000, r => delivered.push(r.prompt))).toEqual([]);
		expect(delivered).toEqual(["remind me"]);
	});

	it("advances recurring schedules past now (latest-missed-only)", () => {
		const scheduler = new ExtensionScheduler();
		let fires = 0;
		const record = scheduler.create({ prompt: "tick", everySeconds: 10 }, 1000);
		expect(record.nextAt).toBe(11_000);

		expect(scheduler.drive(35_000, () => fires++)).toEqual([record.id]);
		expect(fires).toBe(1);
		// 11s, 21s, 31s missed; next slot past 35s is 41s — no catch-up burst.
		expect(scheduler.list()[0]?.nextAt).toBe(41_000);
		expect(scheduler.drive(41_000, () => fires++)).toEqual([record.id]);
		expect(fires).toBe(2);
	});

	it("keeps a due record when delivery throws", () => {
		const scheduler = new ExtensionScheduler();
		const record = scheduler.create({ prompt: "x", afterSeconds: 1 }, 1000);
		const fired = scheduler.drive(2000, () => {
			throw new Error("sink down");
		});
		expect(fired).toEqual([]);
		expect(scheduler.list().map(r => r.id)).toEqual([record.id]);
	});

	it("reschedules on update and deletes by id", () => {
		const scheduler = new ExtensionScheduler();
		const record = scheduler.create({ prompt: "a", afterSeconds: 60 }, 1000);
		const updated = scheduler.update(record.id, { prompt: "b", everySeconds: 30 }, 2000);
		expect(updated.prompt).toBe("b");
		expect(updated.kind).toBe("every");
		expect(updated.nextAt).toBe(32_000);
		expect(scheduler.update(record.id, { title: "t" }, 2000).title).toBe("t");
		expect(scheduler.delete(record.id)).toBe(true);
		expect(scheduler.delete(record.id)).toBe(false);
		expect(() => scheduler.update(record.id, { prompt: "x" }, 2000)).toThrow(/unknown schedule/);
	});

	it("returns copies callers cannot mutate", () => {
		const scheduler = new ExtensionScheduler();
		const record = scheduler.create({ prompt: "a", afterSeconds: 60 }, 1000);
		expect(scheduler.list()[0]).toEqual(record);
		expect(scheduler.list()[0]).not.toBe(record);
	});
});
