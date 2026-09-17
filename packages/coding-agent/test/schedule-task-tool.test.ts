import { describe, expect, test } from "bun:test";
import type { CronTask } from "../src/daemon/crons";
import { describeCronSchedule, type ScheduledTaskHandle, scheduleTaskTool } from "../src/tools/schedule-task";

/**
 * Issue #11 — the agent had no tool to create scheduled tasks, so a user asking
 * for "每天 22:00 跑测试" in the conversation had to leave the session and fill in
 * the 任务中心 form by hand.
 *
 * The tool is thin by design: the daemon owns the cron list in memory and
 * rewrites crons.json on every save, so the tool talks to an injected handle
 * instead of touching the file. What is worth testing is (a) the schedule
 * summary both the tool result and the GUI card render from, and (b) that the
 * handle is actually consulted — including the clear failure when it is absent.
 */

function task(over: Partial<CronTask> = {}): CronTask {
	return {
		id: "cron-1",
		name: "nightly tests",
		enabled: true,
		schedule: { kind: "daily", time: "22:00" },
		prompt: "run the test suite",
		cwd: "/proj",
		state: { createdAt: Date.now(), nextRunAt: Date.now() + 3600_000 },
		...over,
	};
}

function fakeHandle(over: Partial<ScheduledTaskHandle> = {}): {
	handle: ScheduledTaskHandle;
	calls: Array<Record<string, unknown>>;
} {
	const calls: Array<Record<string, unknown>> = [];
	const handle: ScheduledTaskHandle = {
		upsert: async input => {
			calls.push(input as unknown as Record<string, unknown>);
			return task({ name: input.name, schedule: input.schedule });
		},
		list: async () => [task()],
		defaultCwd: () => "/proj",
		...over,
	};
	return { handle, calls };
}

const ctxWith = (handle?: ScheduledTaskHandle) =>
	({ scheduledTasks: handle, sessionManager: { getSessionId: () => "s1" } }) as never;

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content.map(c => c.text ?? "").join("");

describe("describeCronSchedule", () => {
	test("daily with one time", () => {
		expect(describeCronSchedule({ kind: "daily", time: "22:00" })).toContain("daily at 22:00");
	});

	test("daily with several times lists them all", () => {
		const s = describeCronSchedule({ kind: "daily", times: ["09:00", "18:00"] });
		expect(s).toContain("09:00");
		expect(s).toContain("18:00");
	});

	test("weekly names the weekdays", () => {
		expect(describeCronSchedule({ kind: "weekly", time: "18:00", weekdays: [5] })).toContain("周五");
	});

	test("monthly includes the day of month", () => {
		expect(describeCronSchedule({ kind: "monthly", time: "03:00", dayOfMonth: 15 })).toContain("15");
	});

	test("once includes the date", () => {
		expect(describeCronSchedule({ kind: "once", date: "2026-10-01", time: "08:00" })).toContain("2026-10-01");
	});

	test("cron passes the expression through", () => {
		expect(describeCronSchedule({ kind: "cron", cron: "*/5 * * * *" })).toContain("*/5 * * * *");
	});

	test("idle window and timezone are surfaced (闲时任务)", () => {
		const s = describeCronSchedule({
			kind: "daily",
			time: "23:00",
			idleWindow: { start: "23:00", end: "08:00" },
			timezone: "Asia/Shanghai",
		});
		expect(s).toContain("23:00–08:00");
		expect(s).toContain("Asia/Shanghai");
	});
});

describe("schedule_task tool", () => {
	test("creates through the injected handle and reports the next run", async () => {
		const { handle, calls } = fakeHandle();
		const result = await scheduleTaskTool.execute(
			"t1",
			{
				action: "create",
				name: "nightly tests",
				prompt: "run the test suite",
				schedule: { kind: "daily", time: "22:00" },
			},
			undefined,
			ctxWith(handle) as never,
		);
		expect(textOf(result as never)).toContain("created");
		expect(calls.length).toBe(1);
		expect(calls[0]?.cwd).toBe("/proj");
	});

	test("update passes the existing id through", async () => {
		const { handle, calls } = fakeHandle();
		await scheduleTaskTool.execute(
			"t2",
			{
				action: "create",
				id: "cron-9",
				name: "n",
				prompt: "p",
				schedule: { kind: "daily", time: "01:00" },
			},
			undefined,
			ctxWith(handle) as never,
		);
		expect(calls[0]?.id).toBe("cron-9");
	});

	test("requires name and prompt", async () => {
		const { handle, calls } = fakeHandle();
		const result = await scheduleTaskTool.execute(
			"t3",
			{ action: "create", schedule: { kind: "daily", time: "22:00" } },
			undefined,
			ctxWith(handle) as never,
		);
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(calls.length).toBe(0);
	});

	test("requires a schedule", async () => {
		const { handle, calls } = fakeHandle();
		const result = await scheduleTaskTool.execute(
			"t4",
			{ action: "create", name: "n", prompt: "p" },
			undefined,
			ctxWith(handle) as never,
		);
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(calls.length).toBe(0);
	});

	test("surfaces a validator rejection instead of arming a dead task", async () => {
		const { handle } = fakeHandle({
			upsert: async () => {
				throw new Error("daily schedule needs a time");
			},
		});
		const result = await scheduleTaskTool.execute(
			"t5",
			{ action: "create", name: "n", prompt: "p", schedule: { kind: "daily" } },
			undefined,
			ctxWith(handle) as never,
		);
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(textOf(result as never)).toContain("daily schedule needs a time");
	});

	test("lists existing tasks", async () => {
		const { handle } = fakeHandle();
		const result = await scheduleTaskTool.execute("t6", { action: "list" }, undefined, ctxWith(handle) as never);
		expect(textOf(result as never)).toContain("nightly tests");
	});

	test("says so when there is no daemon (standalone TUI/CLI)", async () => {
		const result = await scheduleTaskTool.execute(
			"t7",
			{ action: "create", name: "n", prompt: "p", schedule: { kind: "daily", time: "22:00" } },
			undefined,
			ctxWith(undefined) as never,
		);
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(textOf(result as never)).toContain("unavailable");
	});

	test("creating needs approval, listing does not", () => {
		// The tool declares approval as a resolver function; the CustomTool
		// field is a union of forms, so narrow through its callable shape.
		const approval = scheduleTaskTool.approval as unknown as (args: unknown) => { tier?: string } | undefined;
		expect(approval({ action: "list" })).toMatchObject({ tier: "read" });
		expect(approval({ action: "create" })).toMatchObject({ tier: "write" });
	});
});
