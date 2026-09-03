import type { CronRun, CronSchedule, CronTask } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import type { SessionClient } from "../../lib/client";
import { relTime } from "../../lib/format";

/**
 * Guest scheduled-tasks panel: cron.list rendered as a task list with
 * enable/disable, delete and a minimal add form (prompt + schedule kind +
 * time) — cron.toggle / cron.delete / cron.upsert. Polls every 30s while
 * mounted; run history sits in a collapsed section. Mutations are hidden
 * for read-only guests.
 */

const POLL_MS = 30_000;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const WEEKDAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

interface ScheduledPanelProps {
	client: SessionClient;
	/** Session cwd; null before the first state frame. */
	cwd: string | null;
	readOnly: boolean;
}

export function ScheduledPanel({ client, cwd, readOnly }: ScheduledPanelProps): ReactNode {
	const [tasks, setTasks] = useState<CronTask[] | null>(null);
	const [runs, setRuns] = useState<CronRun[]>([]);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		try {
			// Run history comes from the dedicated cron.runs (newest first,
			// up to 50) — cron.list only carries the global last 20 runs.
			const [res, runsRes] = await Promise.all([
				client.rpc<{ tasks: CronTask[]; runs: CronRun[] }>("cron.list"),
				client
					.rpc<{ runs: CronRun[] }>("cron.runs", { limit: 50 })
					.catch(() => ({ runs: undefined as CronRun[] | undefined })),
			]);
			setTasks(res.tasks);
			setRuns(runsRes.runs ?? res.runs);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [client]);

	useEffect(() => {
		void load();
		const id = window.setInterval(() => void load(), POLL_MS);
		return () => window.clearInterval(id);
	}, [load]);

	const runTask = useCallback(async (fn: () => Promise<{ tasks: CronTask[] } | void>): Promise<void> => {
		try {
			const res = await fn();
			if (res && "tasks" in res) setTasks(res.tasks);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	if (error !== null) {
		return (
			<div className="sh-panel-state">
				<p className="sh-panel-error">{t("load failed: {error}", { error })}</p>
				<button type="button" className="sh-btn" onClick={() => void load()}>
					{t("retry")}
				</button>
			</div>
		);
	}
	if (tasks === null) {
		return <div className="sh-panel-state">{t("loading…")}</div>;
	}

	return (
		<div className="sh-scheduled">
			<div className="sh-panel-head">
				<h2 className="sh-panel-title">{t("scheduled tasks")}</h2>
			</div>
			{!readOnly && <TaskForm client={client} cwd={cwd} onAdded={load} />}
			{tasks.length === 0 ? (
				<p className="sh-panel-muted">{t("no tasks yet")}</p>
			) : (
				<ul className="sh-task-list">
					{tasks.map(task => (
						<TaskRow
							key={task.id}
							task={task}
							readOnly={readOnly}
							onToggle={id => void runTask(() => client.rpc<{ tasks: CronTask[] }>("cron.toggle", { id }))}
							onDelete={id => void runTask(() => client.rpc<{ tasks: CronTask[] }>("cron.delete", { id }))}
						/>
					))}
				</ul>
			)}
			<details className="sh-runs">
				<summary className="sh-runs-summary">{t("run history")}</summary>
				{runs.length === 0 ? (
					<p className="sh-panel-muted">{t("no runs yet")}</p>
				) : (
					<table className="sh-runs-table">
						<tbody>
							{runs.map(run => (
								<tr key={run.id}>
									<td className="sh-runs-name">{run.taskId}</td>
									<td>
										<span className={`sh-status sh-status-${run.status}`}>{run.status}</span>
									</td>
									<td className="sh-runs-time">{relTime(run.startedAt)}</td>
									<td className="sh-runs-err">{run.error}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</details>
		</div>
	);
}

function TaskForm({
	client,
	cwd,
	onAdded,
}: {
	client: SessionClient;
	cwd: string | null;
	onAdded(): Promise<void>;
}): ReactNode {
	const [prompt, setPrompt] = useState("");
	const [kind, setKind] = useState<CronSchedule["kind"]>("daily");
	const [time, setTime] = useState("09:00");
	const [weekday, setWeekday] = useState(1);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = useCallback(async (): Promise<void> => {
		const text = prompt.trim();
		if (!text) {
			setError(t("task prompt required"));
			return;
		}
		const schedule: CronSchedule =
			kind === "once"
				? { kind: "once", date: todayISO(), time }
				: kind === "weekly"
					? { kind: "weekly", time, weekdays: [weekday] }
					: { kind: "daily", time };
		const task: CronTask = {
			id: crypto.randomUUID(),
			name: nameFromPrompt(text),
			enabled: true,
			schedule,
			prompt: text,
			cwd: cwd ?? "",
			state: { createdAt: Date.now() },
		};
		setBusy(true);
		setError(null);
		try {
			await client.rpc<{ tasks: CronTask[] }>("cron.upsert", { task });
			setPrompt("");
			await onAdded();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [client, cwd, prompt, kind, time, weekday, onAdded]);

	return (
		<form
			className="sh-task-form"
			onSubmit={e => {
				e.preventDefault();
				void submit();
			}}
		>
			<label className="sh-field">
				<span className="sh-field-label">{t("task prompt")}</span>
				<input
					className="sh-input"
					value={prompt}
					onChange={e => setPrompt(e.target.value)}
					placeholder={t("task prompt")}
				/>
			</label>
			<div className="sh-task-form-row">
				<label className="sh-field">
					<span className="sh-field-label">{t("schedule kind")}</span>
					<select
						className="sh-input"
						value={kind}
						onChange={e => setKind(e.target.value as CronSchedule["kind"])}
					>
						<option value="once">{t("once")}</option>
						<option value="daily">{t("daily")}</option>
						<option value="weekly">{t("weekly")}</option>
					</select>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">{t("time")}</span>
					<input className="sh-input" type="time" value={time} onChange={e => setTime(e.target.value)} />
				</label>
				{kind === "weekly" && (
					<label className="sh-field">
						<span className="sh-field-label">{t("weekday")}</span>
						<select className="sh-input" value={weekday} onChange={e => setWeekday(Number(e.target.value))}>
							{WEEKDAYS.map((d, i) => (
								<option key={d} value={d}>
									{t(WEEKDAY_KEYS[i]!)}
								</option>
							))}
						</select>
					</label>
				)}
			</div>
			{error !== null && <p className="sh-panel-error">{error}</p>}
			<button type="submit" className="sh-btn sh-btn-primary" disabled={busy}>
				{t("add task")}
			</button>
		</form>
	);
}

function TaskRow({
	task,
	readOnly,
	onToggle,
	onDelete,
}: {
	task: CronTask;
	readOnly: boolean;
	onToggle(id: string): void;
	onDelete(id: string): void;
}): ReactNode {
	const [confirming, setConfirming] = useState(false);
	const scheduleLabel = useMemo(() => describeSchedule(task.schedule), [task.schedule]);
	return (
		<li className="sh-task-row" data-disabled={task.enabled ? undefined : "true"}>
			<div className="sh-task-main">
				<span className="sh-task-name">{task.name}</span>
				<span className="sh-task-schedule">{scheduleLabel}</span>
			</div>
			{!readOnly && (
				<div className="sh-task-actions">
					<button
						type="button"
						className={task.enabled ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
						title={task.enabled ? t("disable task") : t("enable task")}
						onClick={() => onToggle(task.id)}
					>
						{task.enabled ? "●" : "○"}
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-btn-stop"
						title={confirming ? t("confirm delete task?") : t("delete task")}
						onClick={() => {
							if (confirming) {
								onDelete(task.id);
								setConfirming(false);
							} else {
								setConfirming(true);
							}
						}}
						onBlur={() => setConfirming(false)}
					>
						{confirming ? t("confirm delete task?") : "✕"}
					</button>
				</div>
			)}
		</li>
	);
}

function nameFromPrompt(prompt: string): string {
	const words = prompt.trim().split(/\s+/).slice(0, 6).join(" ");
	return words.length > 40 ? `${words.slice(0, 40)}…` : words;
}

function todayISO(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function describeSchedule(s: CronSchedule): string {
	if (s.kind === "once") return `${t("once")} ${s.date ?? ""} ${s.time ?? ""}`.trim();
	if (s.kind === "daily") return `${t("daily")} ${s.time ?? ""}`.trim();
	if (s.kind === "weekly") {
		const days = (s.weekdays ?? []).map(d => t(WEEKDAY_KEYS[d] ?? "Sun")).join(" ");
		return `${t("weekly")} ${days} ${s.time ?? ""}`.trim();
	}
	if (s.kind === "monthly") return `${t("monthly")} ${s.time ?? ""}`.trim();
	return s.cron ?? s.kind;
}
