import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useState } from "react";
import { orderedWeekdayKeys, weekStartIndex } from "../lib/appearance";

/**
 * Task-center views (proma automation-calendar absorption): a calendar
 * month grid and a status board for scheduled tasks, plus the shared
 * schedule-label helper. Both consume the same CronTask list the list
 * view shows — no extra data path.
 */

export interface TaskCenterTask {
	id: string;
	name: string;
	enabled: boolean;
	schedule: {
		kind: "once" | "daily" | "weekly" | "monthly" | "cron";
		time?: string;
		times?: string[];
		date?: string;
		weekdays?: number[];
		dayOfMonth?: number;
		cron?: string;
		idleWindow?: { start: string; end: string };
	};
	state: {
		lastStatus?: "idle" | "running" | "success" | "error";
		lastError?: string;
		nextRunAt?: number;
	};
}

/** Human schedule label (list/detail/board share one source). */
export function taskScheduleLabel(s: TaskCenterTask["schedule"]): string {
	switch (s.kind) {
		case "once":
			return `${s.date ?? "?"} ${s.time ?? ""}`.trim();
		case "daily":
			return `${t("scheduled daily")} ${(s.times?.length ? s.times : s.time ? [s.time] : ["09:00"]).join(" / ")}`;
		case "weekly": {
			const names = [
				t("scheduled sun"),
				t("scheduled mon"),
				t("scheduled tue"),
				t("scheduled wed"),
				t("scheduled thu"),
				t("scheduled fri"),
				t("scheduled sat"),
			];
			return `${t("scheduled weekly")} ${(s.weekdays ?? []).map(d => names[d] ?? d).join("、")} ${s.time ?? ""}`;
		}
		case "monthly":
			return `${t("scheduled monthly")} ${s.dayOfMonth ?? 1} ${s.time ?? ""}`;
		case "cron":
			return `${t("scheduled cron")} ${s.cron ?? ""}`;
		default:
			return "";
	}
}

/** "M月D日 HH:mm" (zh) via the word list — never a hardcoded locale. */
function fmtNextRunAt(epoch: number): string {
	const d = new Date(epoch);
	return t("scheduled next run at", {
		month: d.getMonth() + 1,
		day: d.getDate(),
		time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
	});
}

/** Days of a month (1-based) a task is scheduled to run on. */
function monthRunDays(task: TaskCenterTask, year: number, month: number): number[] {
	const s = task.schedule;
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	switch (s.kind) {
		case "daily":
			return Array.from({ length: daysInMonth }, (_, i) => i + 1);
		case "weekly": {
			const wd = new Set(s.weekdays ?? []);
			const out: number[] = [];
			for (let d = 1; d <= daysInMonth; d++) if (wd.has(new Date(year, month, d).getDay())) out.push(d);
			return out;
		}
		case "monthly":
			return s.dayOfMonth !== undefined && s.dayOfMonth <= daysInMonth ? [s.dayOfMonth] : [];
		case "once": {
			if (!s.date) return [];
			const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.date);
			if (!m) return [];
			const y = Number(m[1]);
			const mo = Number(m[2]);
			const d = Number(m[3]);
			return y === year && mo === month + 1 ? [d] : [];
		}
		case "cron":
			// 5-field cron on a month grid: mark days whose dow matches the
			// cron's dow field when it is a plain list (best effort).
			return cronDowDays(task, year, month);
		default:
			return [];
	}
}

function cronDowDays(task: TaskCenterTask, year: number, month: number): number[] {
	const expr = (task.schedule.cron ?? "").trim().split(/\s+/);
	if (expr.length !== 5) return [];
	const dow = expr[4]!;
	if (dow === "*") return Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) => i + 1);
	if (/^\d+$/.test(dow)) {
		const target = Number(dow) % 7;
		const out: number[] = [];
		for (let d = 1; d <= new Date(year, month + 1, 0).getDate(); d++) {
			if (new Date(year, month, d).getDay() === target) out.push(d);
		}
		return out;
	}
	return [];
}

/** Calendar month grid (proma automation-calendar parity). The grid and
 *  weekday headers follow the settings-page week start — same rotation the
 *  editor's CalendarPicker uses, never a hardcoded Sunday. */
export function TaskCalendarView({
	tasks,
	runs,
	onSelectTask,
}: {
	tasks: TaskCenterTask[];
	runs: { taskId: string; status?: string; startedAt?: number }[];
	onSelectTask?(id: string): void;
}): ReactNode {
	const [cursor, setCursor] = useState(new Date());
	const year = cursor.getFullYear();
	const month = cursor.getMonth();
	const startDow = (new Date(year, month, 1).getDay() - weekStartIndex() + 7) % 7;
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	const today = new Date();
	const isToday = (d: number): boolean =>
		today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
	const monthKey = `${year}-${month}`;

	// day → tasks scheduled that day
	const byDay = new Map<number, TaskCenterTask[]>();
	for (const task of tasks) {
		for (const d of monthRunDays(task, year, month)) {
			const arr = byDay.get(d) ?? [];
			arr.push(task);
			byDay.set(d, arr);
		}
	}
	// day → last run status per task (from run history, newest wins)
	const runStatusByDay = new Map<string, string>();
	for (const run of runs) {
		if (!run.startedAt) continue;
		const d = new Date(run.startedAt);
		if (d.getFullYear() !== year || d.getMonth() !== month) continue;
		runStatusByDay.set(`${d.getDate()}:${run.taskId}`, run.status ?? "success");
	}

	const cells: ReactNode[] = [];
	for (let i = 0; i < startDow; i++)
		cells.push(<div key={`pad-${i}`} className="gui-taskcal-cell gui-taskcal-cell--pad" />);
	for (let d = 1; d <= daysInMonth; d++) {
		const dayTasks = byDay.get(d) ?? [];
		const failed = dayTasks.some(task => runStatusByDay.get(`${d}:${task.id}`) === "error");
		const ran = dayTasks.some(task => runStatusByDay.has(`${d}:${task.id}`));
		cells.push(
			<button
				type="button"
				key={d}
				className={`gui-taskcal-cell${isToday(d) ? " gui-taskcal-cell--today" : ""}`}
				onClick={() => dayTasks.length === 1 && onSelectTask?.(dayTasks[0]!.id)}
			>
				<span className="gui-taskcal-day">{d}</span>
				{dayTasks.length > 0 && (
					<span
						className={`gui-taskcal-dots${failed ? " gui-taskcal-dots--fail" : ran ? " gui-taskcal-dots--done" : ""}`}
					>
						{dayTasks.slice(0, 3).map(task => (
							<span key={task.id} className="gui-taskcal-dot" />
						))}
						{dayTasks.length > 3 && <span className="gui-taskcal-more">+{dayTasks.length - 3}</span>}
					</span>
				)}
			</button>,
		);
	}

	return (
		<div className="gui-taskcal" data-month={monthKey}>
			<div className="gui-taskcal-head">
				<button
					type="button"
					className="gui-taskcal-nav"
					onClick={() => setCursor(new Date(year, month - 1, 1))}
					aria-label={t("previous month")}
				>
					‹
				</button>
				<span className="gui-taskcal-title">{t("task calendar month", { year, month: month + 1 })}</span>
				<button
					type="button"
					className="gui-taskcal-nav"
					onClick={() => setCursor(new Date(year, month + 1, 1))}
					aria-label={t("next month")}
				>
					›
				</button>
			</div>
			{tasks.length === 0 && <p className="gui-taskcal-empty">{t("task calendar empty")}</p>}
			<div className="gui-taskcal-grid">
				{orderedWeekdayKeys().map(k => (
					<div key={k} className="gui-taskcal-weekday">
						{t(k as never)}
					</div>
				))}
				{cells}
			</div>
		</div>
	);
}

/** Status board (看板): 待运行 / 已暂停 / 最近失败 columns. */
export function TaskBoardView({
	tasks,
	onSelectTask,
	onToggle,
	onDelete,
}: {
	tasks: TaskCenterTask[];
	onSelectTask?(id: string): void;
	onToggle?(id: string): void;
	onDelete?(id: string): void;
}): ReactNode {
	const ready = tasks.filter(task => task.enabled);
	const paused = tasks.filter(task => !task.enabled);
	const failed = tasks.filter(task => task.state.lastStatus === "error");
	const columns: { key: string; title: string; list: TaskCenterTask[]; tone: string }[] = [
		{ key: "ready", title: t("board ready"), list: ready, tone: "" },
		{ key: "paused", title: t("board paused"), list: paused, tone: "gui-taskboard-col--muted" },
		{ key: "failed", title: t("board failed"), list: failed, tone: "gui-taskboard-col--fail" },
	];
	return (
		<div className="gui-taskboard">
			{columns.map(col => (
				<div key={col.key} className={`gui-taskboard-col ${col.tone}`}>
					<div className="gui-taskboard-col-head">
						<span>{col.title}</span>
						<span className="gui-taskboard-count">{col.list.length}</span>
					</div>
					<div className="gui-taskboard-col-body">
						{col.list.length === 0 ? (
							<div className="gui-taskboard-empty">{t("board empty")}</div>
						) : (
							col.list.map(task => (
								<div key={task.id} className="gui-taskboard-card">
									<button
										type="button"
										className="gui-taskboard-card-main"
										onClick={() => onSelectTask?.(task.id)}
									>
										<span className="gui-taskboard-card-name">{task.name || t("scheduled untitled")}</span>
										<span className="gui-taskboard-card-sched">{taskScheduleLabel(task.schedule)}</span>
										{task.state.nextRunAt && task.enabled && (
											<span className="gui-taskboard-card-next">
												{t("scheduled next")} {fmtNextRunAt(task.state.nextRunAt)}
											</span>
										)}
										{col.key === "failed" && task.state.lastError && (
											<span className="gui-taskboard-card-err">{task.state.lastError}</span>
										)}
									</button>
									<div className="gui-taskboard-card-actions">
										<button
											type="button"
											onClick={() => onToggle?.(task.id)}
											title={task.enabled ? t("board pause") : t("board resume")}
										>
											{task.enabled ? "⏸" : "▶"}
										</button>
										<button type="button" onClick={() => onDelete?.(task.id)} title={t("board delete")}>
											🗑
										</button>
									</div>
								</div>
							))
						)}
					</div>
				</div>
			))}
		</div>
	);
}
