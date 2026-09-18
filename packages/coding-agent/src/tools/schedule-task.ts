import { type } from "@musepi/musepi-type";
import { prompt } from "@musepi/pi-utils";
import type { CronSchedule, CronTask } from "../daemon/crons";

/** Task-level thinking effort (matches CronTask.thinkingLevel). */
export type CronThinkingLevel = NonNullable<CronTask["thinkingLevel"]>;

import type { CustomTool } from "../extensibility/custom-tools/types";

/**
 * Scheduled-task tool (issue #11) — lets the agent create and inspect the
 * daemon's scheduled tasks (the same store the desktop 任务中心 edits), so the
 * user can say "每天 22:00 跑一次测试" in the conversation instead of leaving the
 * session to fill a form.
 *
 * The handle (`ctx.scheduledTasks`) is injected by the daemon, because the
 * daemon OWNS the task list in memory and rewrites `~/.musepi/crons.json` on
 * every change: a tool writing that file directly would be silently clobbered
 * by the next daemon save. Standalone TUI/CLI sessions have no daemon to
 * schedule through and say so.
 */

const scheduleSchema = type({
	kind: type
		.enumerated("once", "daily", "weekly", "monthly", "cron")
		.describe(
			'"once" needs `date`; "daily"/"weekly"/"monthly" need `time` (and `weekdays` / `dayOfMonth`); "cron" needs a 5-field `cron` expression',
		),
	"time?": type("string").describe('HH:mm, 24h — required for daily/weekly/monthly (e.g. "22:00")'),
	"times?": type("string[]").describe("Several HH:mm fire times in one day (daily only)"),
	"date?": type("string").describe('YYYY-MM-DD — required for kind="once"'),
	"weekdays?": type("number[]").describe("0 (Sunday) .. 6 (Saturday) — required for weekly"),
	"dayOfMonth?": type("number").describe("1..31 — required for monthly"),
	"cron?": type("string").describe('5-field cron expression — required for kind="cron" (e.g. "0 22 * * *")'),
	"idleWindow?": type({
		start: type("string").describe('HH:mm — window opens (e.g. "23:00")'),
		end: type("string").describe("HH:mm — window closes; may be before start for a cross-midnight window"),
	}).describe("Run only inside this quiet-hours window (闲时任务); a due run outside is deferred to its start"),
	"timezone?": type("string").describe("IANA timezone for the wall-clock times (default: the machine's local zone)"),
});

const scheduleTaskSchema = type({
	action: type
		.enumerated("create", "list")
		.describe('"create" adds or updates a task, "list" shows the existing ones'),
	"name?": type("string").describe('Task name, shown in the task center (required for action="create")'),
	"prompt?": type("string").describe(
		'What to run each time, written as an instruction to the agent (required for action="create")',
	),
	"schedule?": scheduleSchema.describe('When to run (required for action="create")'),
	"id?": type("string").describe("Existing task id to update instead of creating a new one"),
	"cwd?": type("string").describe("Workspace the task runs in (default: the current session's workspace)"),
	"model?": type("string").describe("Model id for the task (default: the session default)"),
	"thinkingLevel?": type
		.enumerated("default", "low", "medium", "high")
		.describe("Thinking effort for the task's runs"),
});

export interface ScheduledTaskHandle {
	upsert(input: {
		id?: string;
		name: string;
		prompt: string;
		schedule: CronSchedule;
		cwd?: string;
		model?: string;
		thinkingLevel?: CronThinkingLevel;
	}): Promise<CronTask>;
	list(): Promise<CronTask[]>;
	/** Current workspace, used when the call omits `cwd`. */
	defaultCwd(): string;
}

interface ScheduleTaskDetails {
	readonly action: "create" | "list";
	readonly taskId?: string;
	readonly scheduleSummary?: string;
	readonly nextRunAt?: number;
	readonly idleWindow?: { start: string; end: string };
	readonly tasks?: Array<{ id: string; name: string; summary: string; nextRunAt?: number }>;
}

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * Human-readable schedule summary — also the string the GUI card renders, so
 * the tool result and the card can never drift. Pure: the tool tests cover it
 * directly instead of asserting on a whole agent turn.
 */
export function describeCronSchedule(schedule: CronSchedule): string {
	const parts: string[] = [];
	const times = schedule.times?.length ? schedule.times : schedule.time ? [schedule.time] : [];
	switch (schedule.kind) {
		case "once":
			parts.push(schedule.date ? `once on ${schedule.date}` : "once");
			if (schedule.time) parts.push(`at ${schedule.time}`);
			break;
		case "daily":
			parts.push(times.length > 1 ? `daily at ${times.join(", ")}` : `daily at ${times[0] ?? "—"}`);
			break;
		case "weekly": {
			const days = (schedule.weekdays ?? []).map(d => WEEKDAYS_ZH[d] ?? String(d));
			parts.push(`weekly on ${days.length ? days.join("/") : "—"} at ${times[0] ?? "—"}`);
			break;
		}
		case "monthly":
			parts.push(`monthly on day ${schedule.dayOfMonth ?? "—"} at ${times[0] ?? "—"}`);
			break;
		case "cron":
			parts.push(`cron ${schedule.cron ?? "—"}`);
			break;
		default:
			parts.push("unscheduled");
	}
	if (schedule.idleWindow) parts.push(`idle window ${schedule.idleWindow.start}–${schedule.idleWindow.end}`);
	if (schedule.timezone) parts.push(schedule.timezone);
	return parts.join(" · ");
}

export const scheduleTaskTool: CustomTool<typeof scheduleTaskSchema, ScheduleTaskDetails> = {
	name: "schedule_task",
	label: "ScheduleTask",
	strict: false,
	approval: (args: unknown) => {
		const a = (args ?? {}) as { action?: string };
		// Listing is harmless; creating a task makes the agent run unattended
		// prompts later, which the user should see before it is armed.
		return a.action === "list"
			? { tier: "read" }
			: { tier: "write", reason: "Creates a scheduled task that will run the given prompt unattended." };
	},
	formatApprovalDetails: (args: unknown) => {
		const a = (args ?? {}) as { action?: string; name?: string; schedule?: CronSchedule };
		const lines = [`Action: ${a.action ?? "create"}`];
		if (a.name) lines.push(`Name: ${a.name}`);
		if (a.schedule) lines.push(`Schedule: ${describeCronSchedule(a.schedule)}`);
		return lines;
	},
	description: prompt.render(
		'Create or list scheduled tasks — the same tasks the desktop 任务中心 (Scheduled tasks) page manages. Use this when the user asks in natural language for something to run later or repeatedly ("每天 22:00 检查分支并跑测试", "每周五 18:00 扫依赖漏洞", "夜里机器空闲时重构检查"). Put the actual work in `prompt`, written as an instruction to the agent; use `idleWindow` for 闲时任务 so a due run waits for the quiet window. After creating, report the task name, the schedule and the next run time to the user.',
	),
	parameters: scheduleTaskSchema,
	async execute(_toolCallId, params, _onUpdate, ctx) {
		// Daemon-injected handle; carried on CustomToolContext since the
		// #25 fix (createCustomToolContext passes it through).
		const handle = ctx.scheduledTasks;
		if (!handle) {
			return {
				content: [
					{
						type: "text",
						text: "Scheduled tasks are unavailable in this environment (no daemon). Use the task center in the desktop GUI instead.",
					},
				],
				details: { action: params.action },
				isError: true,
			};
		}
		if (params.action === "list") {
			const tasks = await handle.list();
			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "No scheduled tasks yet." }],
					details: { action: "list", tasks: [] },
				};
			}
			const rows = tasks.map(t => ({
				id: t.id,
				name: t.name,
				summary: describeCronSchedule(t.schedule),
				nextRunAt: t.state.nextRunAt,
			}));
			const lines = rows.map(
				r =>
					`- ${r.name} (${r.id}): ${r.summary}${r.nextRunAt ? ` → next ${new Date(r.nextRunAt).toLocaleString()}` : ""}`,
			);
			return {
				content: [{ type: "text", text: `Scheduled tasks:\n${lines.join("\n")}` }],
				details: { action: "list", tasks: rows },
			};
		}

		// action === "create"
		const name = params.name?.trim();
		const taskPrompt = params.prompt?.trim();
		if (!name || !taskPrompt) {
			return {
				content: [{ type: "text", text: "`name` and `prompt` are required to create a scheduled task." }],
				details: { action: "create" },
				isError: true,
			};
		}
		if (!params.schedule) {
			return {
				content: [{ type: "text", text: "`schedule` is required to create a scheduled task." }],
				details: { action: "create" },
				isError: true,
			};
		}
		const schedule = params.schedule as CronSchedule;
		try {
			const task = await handle.upsert({
				id: params.id,
				name,
				prompt: taskPrompt,
				schedule,
				cwd: params.cwd ?? handle.defaultCwd(),
				model: params.model,
				thinkingLevel: params.thinkingLevel,
			});
			const summary = describeCronSchedule(task.schedule);
			const next = task.state.nextRunAt;
			const lines = [
				`Scheduled task "${task.name}" ${params.id ? "updated" : "created"}.`,
				`- id: ${task.id}`,
				`- schedule: ${summary}`,
				next ? `- next run: ${new Date(next).toLocaleString()}` : "- next run: not scheduled (disabled)",
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					action: "create",
					taskId: task.id,
					scheduleSummary: summary,
					nextRunAt: next,
					idleWindow: task.schedule.idleWindow,
				},
			};
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Could not schedule the task: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				details: { action: "create" },
				isError: true,
			};
		}
	},
};
