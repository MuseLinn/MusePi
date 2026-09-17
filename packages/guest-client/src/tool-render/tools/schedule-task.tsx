import type { ReactNode } from "react";
import { openScheduledTaskFromChat } from "../../components/transcript/canvas-jump.js";
import { t } from "../../i18n/index.js";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { isRecord, str } from "../util";

/**
 * `schedule_task` renderer (issue #11) — the agent created (or listed) a
 * scheduled task in the conversation, and the user should get a structured
 * card instead of a raw JSON row: name, schedule summary, next run, and a
 * button that hops to the 任务中心 with the task already selected.
 *
 * Everything is read defensively from `args`/`details` — both arrive as plain
 * wire JSON and either may be partial (the call may still be streaming).
 */

interface TaskView {
	id?: string;
	name: string;
	summary?: string;
	nextRunAt?: number;
	idleWindow?: { start?: string; end?: string };
}

function detailsOf(result: unknown): Record<string, unknown> | null {
	const r = isRecord(result) ? result : null;
	return isRecord(r?.details) ? (r.details as Record<string, unknown>) : null;
}

function nextRunOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `str()` yields null for anything unusable; the view wants undefined. */
function opt(value: unknown): string | undefined {
	return str(value) ?? undefined;
}

function idleWindowOf(source: unknown): { start: string; end: string } | undefined {
	if (!isRecord(source)) return undefined;
	const start = opt(source.start);
	const end = opt(source.end);
	return start !== undefined && end !== undefined ? { start, end } : undefined;
}

/** The task the card describes: `details` wins (it is the daemon's answer,
 *  including the resolved next run), `args` fills the streaming gap. */
function taskOf(args: unknown, result: unknown): TaskView {
	const a = isRecord(args) ? args : null;
	const d = detailsOf(result);
	const schedule = isRecord(a?.schedule) ? a.schedule : null;
	return {
		id: opt(d?.taskId) ?? opt(a?.id),
		name: opt(a?.name) ?? "",
		summary: opt(d?.scheduleSummary),
		nextRunAt: nextRunOf(d?.nextRunAt),
		idleWindow: idleWindowOf(d?.idleWindow) ?? idleWindowOf(schedule?.idleWindow),
	};
}

function fmtNextRun(at: number | undefined): string {
	if (at === undefined) return t("not scheduled");
	try {
		return new Date(at).toLocaleString();
	} catch {
		return t("not scheduled");
	}
}

export const scheduleTaskRenderer: ToolRenderer = {
	Summary: ({ args, result }: ToolRenderProps): string => {
		const task = taskOf(args, result);
		const action = str((isRecord(args) ? args : null)?.action) ?? "create";
		// `scheduled tasks` already means the 任务中心 page; the card title
		// uses the singular task label.
		if (action === "list") return t("scheduled task");
		return `${t("scheduled task")}${task.name ? ` · ${task.name}` : ""}`;
	},
	Body: ({ args, result }: ToolRenderProps): ReactNode => {
		const action = str((isRecord(args) ? args : null)?.action) ?? "create";
		if (action === "list") {
			const d = detailsOf(result);
			const rows = Array.isArray(d?.tasks) ? (d.tasks as Array<Record<string, unknown>>) : [];
			if (rows.length === 0) return <span className="tv-row-val">{t("no scheduled tasks")}</span>;
			return (
				<div className="tv-board">
					{rows.map((row, i) => (
						<div className="tv-board-meta" key={str(row.id) ?? String(i)}>
							{`${str(row.name) ?? ""} — ${str(row.summary) ?? ""}`}
						</div>
					))}
				</div>
			);
		}
		const task = taskOf(args, result);
		const schedule = isRecord(args) && isRecord(args.schedule) ? opt(args.schedule.kind) : undefined;
		return (
			<div className="tv-board">
				<div className="tv-board-head">
					<span className="tv-board-title">{task.name || t("scheduled task")}</span>
					<span className="tv-board-tag">{t("scheduled task created")}</span>
				</div>
				<div className="tv-board-meta">{task.summary ?? (schedule ? t("schedule pending") : "")}</div>
				{task.idleWindow?.start && task.idleWindow.end ? (
					<div className="tv-board-meta">{`🌙 ${t("idle window")} ${task.idleWindow.start}–${task.idleWindow.end}`}</div>
				) : null}
				<div className="tv-board-meta">{`${t("next run")}: ${fmtNextRun(task.nextRunAt)}`}</div>
				{task.id ? (
					<button
						type="button"
						className="tv-board-open"
						onClick={() => openScheduledTaskFromChat(task.id as string, task.name)}
					>
						<span>◷</span>
						{t("open task center")}
						<span className="tv-board-open-arrow">→</span>
					</button>
				) : null}
			</div>
		);
	},
};
