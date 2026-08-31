import { t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { WEEK_START_KEY } from "../lib/appearance";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";
import { GuiSelect } from "./GuiSelect";
import { MenuPopup } from "./MenuPopup";
import { TaskBoardView, TaskCalendarView } from "./TaskCenterViews";

/**
 * Scheduled tasks (定时任务) — openchamber scheduled-task parity.
 * Tasks persist on the daemon (~/.musepi/crons.json); the daemon scans
 * every 30s and runs each due task's prompt in a fresh session bound to
 * its cwd. Layout mirrors openchamber: workspaces (by cwd) on the left,
 * a detail panel for the selected task on the right; the editor offers
 * multiple daily times, weekday multi-select, a calendar for one-off
 * runs, cron examples with next-run preview, timezone, model and
 * thinking level.
 */

interface CronSchedule {
	kind: "once" | "daily" | "weekly" | "monthly" | "cron";
	/** HH:mm — weekly / monthly / once fallback */
	time?: string;
	/** HH:mm list — daily (openchamber: multiple fire times) */
	times?: string[];
	/** YYYY-MM-DD — once */
	date?: string;
	/** 0 (Sun) .. 6 (Sat) — weekly */
	weekdays?: number[];
	/** 1..31 — monthly */
	dayOfMonth?: number;
	/** cron expression (5 fields) — kind=cron */
	cron?: string;
	/** Idle-run window (闲时任务): HH:mm–HH:mm; due runs outside defer. */
	idleWindow?: { start: string; end: string };
	timezone?: string;
}

interface CronTask {
	id: string;
	name: string;
	enabled: boolean;
	schedule: CronSchedule;
	prompt: string;
	cwd: string;
	model?: string;
	thinkingLevel?: "default" | "low" | "medium" | "high";
	state: {
		createdAt: number;
		lastRunAt?: number;
		lastStatus?: "idle" | "running" | "success" | "error";
		lastError?: string;
		lastSessionId?: string;
		nextRunAt?: number;
	};
}

/** Non-null fallback for dialog data props during DialogFrame's exit frame
 *  (draft/deleteTarget are already null then — same pattern as
 *  SaveImageDialog's `?? ""`). Must be a valid CronTask so CronEditor's
 *  useState initializers and task.name renders never see null. */
const EMPTY_TASK: CronTask = {
	id: "",
	name: "",
	enabled: true,
	schedule: { kind: "cron", cron: "" },
	prompt: "",
	cwd: "",
	state: { createdAt: 0 },
};

interface CronRun {
	id: string;
	taskId: string;
	startedAt: number;
	finishedAt?: number;
	status: string;
	error?: string;
	sessionId?: string;
}

const WEEKDAY_KEYS = [
	"scheduled sun",
	"scheduled mon",
	"scheduled tue",
	"scheduled wed",
	"scheduled thu",
	"scheduled fri",
	"scheduled sat",
];

/** Week start from the settings page (auto → Monday for zh locale),
 *  as a day index (0 = Sunday). Calendar grids and weekday pickers
 *  rotate to match instead of hardcoding Sunday first. */
function weekStartIndex(): number {
	const v = localStorage.getItem(WEEK_START_KEY);
	if (v === "sunday") return 0;
	if (v === "monday") return 1;
	return 1; // auto → Monday (zh-CN)
}

/** Weekday labels ordered from the configured week start. */
function orderedWeekdayKeys(): string[] {
	const start = weekStartIndex();
	return Array.from({ length: 7 }, (_, i) => WEEKDAY_KEYS[(start + i) % 7]!);
}

const TIMEZONES = [
	"Asia/Shanghai",
	"Asia/Tokyo",
	"Asia/Singapore",
	"Europe/London",
	"Europe/Berlin",
	"America/New_York",
	"America/Los_Angeles",
	"UTC",
];

const CRON_EXAMPLES: Array<{ expr: string; label: string }> = [
	{ expr: "*/5 * * * *", label: "scheduled cron ex every5" },
	{ expr: "0 * * * *", label: "scheduled cron ex hourly" },
	{ expr: "0 9 * * 1", label: "scheduled cron ex monday9" },
	{ expr: "0 9,17 * * *", label: "scheduled cron ex 9and17" },
	{ expr: "0 0 1 * *", label: "scheduled cron ex month1" },
];

function scheduleLabel(s: CronSchedule): string {
	const tz = s.timezone && s.timezone !== "Asia/Shanghai" ? ` (${s.timezone})` : "";
	switch (s.kind) {
		case "once":
			return `${s.date ?? "?"} ${s.time ?? ""}`.trim();
		case "daily": {
			const times = s.times?.length ? s.times : s.time ? [s.time] : [];
			return `${t("scheduled daily")} ${times.join(" / ")}${tz}`;
		}
		case "weekly":
			return `${t("scheduled weekly")} ${(s.weekdays ?? []).map(d => t(WEEKDAY_KEYS[d] as never)).join("")} ${s.time ?? ""}`;
		case "monthly":
			return `${t("scheduled monthly")} ${s.dayOfMonth ?? "?"} ${s.time ?? ""}`;
		case "cron":
			return `cron ${s.cron ?? ""}`;
	}
}

function fmtTime(ms?: number): string {
	if (!ms) return "—";
	const d = new Date(ms);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Openchamber-style relative label: 刚刚 / N 分钟后 / HH:mm. */
function fmtRelative(ms: number): string {
	const diff = ms - Date.now();
	if (diff > -60_000 && diff < 90_000) return t("scheduled soon");
	const abs = Math.abs(diff);
	if (abs < 60 * 60_000) {
		const m = Math.max(1, Math.round(abs / 60_000));
		return diff >= 0 ? t("scheduled in min", { count: m }) : t("scheduled min ago", { count: m });
	}
	return fmtTime(ms);
}

const STATUS_CLASS: Record<string, string> = {
	success: "gui-cron-status--ok",
	error: "gui-cron-status--err",
	running: "gui-cron-status--run",
};

export function ScheduledTasksPage({
	rpc,
	onBack,
	onOpenSession,
}: {
	rpc?: { request(method: string, params?: Record<string, unknown>): Promise<unknown> };
	onBack(): void;
	/** Open a session by id (openchamber scheduled-task parity: the task
	 *  page jumps to the latest run's session). */
	onOpenSession?(id: string): void;
}): ReactNode {
	const [view, setView] = useState<"calendar" | "board" | "tasks">("tasks");
	const [tasks, setTasks] = useState<CronTask[]>([]);
	const [runs, setRuns] = useState<CronRun[]>([]);
	const [draft, setDraft] = useState<CronTask | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<CronTask | null>(null);
	const [busy, setBusy] = useState(false);
	const aliveRef = useRef(true);
	// DialogFrame keeps the dialog mounted through its exit animation —
	// hold the last non-null task so the closing frame still has content
	// (Pop/DialogFrame parity: host mounts unconditionally, `open` drives
	// enter/exit; conditional mount would drop the close animation).
	const draftRef = useRef<CronTask | null>(null);
	if (draft) draftRef.current = draft;
	const deleteTargetRef = useRef<CronTask | null>(null);
	if (deleteTarget) deleteTargetRef.current = deleteTarget;
	const editorTask = draft ?? draftRef.current;
	const deleteTask = deleteTarget ?? deleteTargetRef.current;

	const refresh = (): void => {
		if (!rpc) return;
		void rpc
			.request("cron.list")
			.then(res => {
				const r = res as { tasks?: CronTask[]; runs?: CronRun[] } | null;
				if (r?.tasks) setTasks(r.tasks);
				if (r?.runs) setRuns(r.runs);
			})
			.catch(() => {});
	};

	useEffect(() => {
		aliveRef.current = true;
		refresh();
		// Poll while the page is open so running tasks flip to success/error.
		const timer = setInterval(() => {
			if (aliveRef.current) refresh();
		}, 30_000);
		return () => {
			aliveRef.current = false;
			clearInterval(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once refresh
	}, [refresh]);

	// Default selection: first task (openchamber selects the top row).
	const selected = tasks.find(x => x.id === selectedId) ?? null;
	useEffect(() => {
		if (!selectedId && tasks.length > 0) setSelectedId(tasks[0]!.id);
		else if (selectedId && !tasks.some(x => x.id === selectedId)) setSelectedId(tasks[0]?.id ?? null);
	}, [tasks, selectedId]);

	/** Session ids a task ever ran (last run + run history). */
	const taskSessionIds = (task: CronTask): string[] => {
		const ids = new Set<string>();
		if (task.state.lastSessionId) ids.add(task.state.lastSessionId);
		for (const run of runs) {
			if (run.taskId === task.id && run.sessionId) ids.add(run.sessionId);
		}
		return [...ids];
	};

	// Workspace grouping (openchamber: folders per project; ~ for home).
	const groups = useMemo(() => {
		const byCwd = new Map<string, CronTask[]>();
		for (const task of tasks) {
			const key = task.cwd?.trim() || "~";
			const list = byCwd.get(key) ?? [];
			list.push(task);
			byCwd.set(key, list);
		}
		return [...byCwd.entries()]
			.sort(([a], [b]) => (a === "~" ? -1 : b === "~" ? 1 : a.localeCompare(b)))
			.map(([cwd, list]) => ({ cwd, tasks: list.sort((a, b) => a.name.localeCompare(b.name)) }));
	}, [tasks]);

	const save = (task: CronTask): void => {
		if (!rpc) return;
		setBusy(true);
		void rpc
			.request("cron.upsert", { task })
			.then(res => {
				const r = res as { tasks?: CronTask[] } | null;
				if (r?.tasks) {
					setTasks(r.tasks);
					setSelectedId(task.id || r.tasks[0]?.id || null);
				}
				setDraft(null);
			})
			.catch(() => {})
			.finally(() => setBusy(false));
	};

	const remove = (id: string, cleanup: "none" | "archive" | "delete"): void => {
		if (!rpc) return;
		const task = deleteTarget ?? tasks.find(t => t.id === id);
		// Archive is GUI-side (archived sessions live in localStorage);
		// "delete" additionally tells the daemon to remove the sessions.
		if (cleanup === "archive" && task) {
			const ids = taskSessionIds(task);
			if (ids.length > 0) {
				try {
					const raw = JSON.parse(localStorage.getItem("musepi-gui-archived") ?? "[]") as {
						sessionId: string;
						archivedAt: number;
						cwd?: string;
					}[];
					for (const sid of ids) {
						if (!raw.some(a => a.sessionId === sid)) {
							raw.push({ sessionId: sid, archivedAt: Date.now(), cwd: task.cwd || undefined });
						}
					}
					localStorage.setItem("musepi-gui-archived", JSON.stringify(raw));
					window.dispatchEvent(new CustomEvent("musepi-gui-archived-changed"));
				} catch {
					// storage unavailable — keep the task delete going
				}
			}
		}
		void rpc.request("cron.delete", cleanup === "delete" ? { id, cleanup } : { id }).then(res => {
			const r = res as { tasks?: CronTask[] } | null;
			if (r?.tasks) setTasks(r.tasks);
			setDeleteTarget(null);
		});
	};

	const toggle = (task: CronTask): void => {
		if (!rpc) return;
		void rpc.request("cron.toggle", { id: task.id, enabled: !task.enabled }).then(res => {
			const r = res as { tasks?: CronTask[] } | null;
			if (r?.tasks) setTasks(r.tasks);
		});
	};

	const runNow = (id: string): void => {
		if (!rpc) return;
		void rpc.request("cron.runNow", { id }).then(res => {
			const r = res as { tasks?: CronTask[] } | null;
			if (r?.tasks) setTasks(r.tasks);
			// The run's session id lands on the task asynchronously
			// (createSession) — re-pull so the delete dialog's session
			// count reflects the run.
			refresh();
		});
	};

	return (
		<div className="gui-scheduled">
			<div className="gui-scheduled-head">
				<h2 className="gui-scheduled-title">{t("scheduled tasks")}</h2>
				<div className="gui-taskcenter-tabs" role="tablist">
					{(["calendar", "board", "tasks"] as const).map(v => (
						<button
							type="button"
							key={v}
							role="tab"
							aria-selected={view === v}
							className={`gui-taskcenter-tab${view === v ? " gui-taskcenter-tab--active" : ""}`}
							onClick={() => setView(v)}
						>
							<Icon
								name={v === "calendar" ? "calendar" : v === "board" ? "list-check-2" : "calendar-schedule"}
								className="h-4 w-4"
							/>
							<span>
								{v === "calendar"
									? t("task center calendar")
									: v === "board"
										? t("task center board")
										: t("task list")}
							</span>
						</button>
					))}
				</div>
				<p className="gui-scheduled-desc">{t("scheduled tasks desc")}</p>
				<div className="gui-scheduled-actions">
					<button
						type="button"
						className="gui-btn gui-scheduled-new"
						onClick={() =>
							setDraft({
								id: "",
								name: "",
								enabled: true,
								schedule: { kind: "daily", times: ["09:00"], timezone: "Asia/Shanghai" },
								prompt: "",
								cwd: "",
								thinkingLevel: "default",
								state: { createdAt: Date.now() },
							})
						}
					>
						<Icon name="add" className="h-4 w-4" />
						<span>{t("scheduled new")}</span>
					</button>
					<button
						type="button"
						className="gui-btn"
						onClick={refresh}
						title={t("board refresh")}
						aria-label={t("board refresh")}
					>
						<Icon name="refresh" className="h-4 w-4 oc-icon-spin" />
					</button>
					<button type="button" className="gui-btn" onClick={onBack}>
						{t("back to workspace")}
					</button>
				</div>
			</div>

			{view === "calendar" ? (
				<div className="gui-taskcenter-body">
					<TaskCalendarView
						tasks={tasks}
						runs={runs.map(r => ({ taskId: r.taskId, status: r.status, startedAt: r.startedAt }))}
						onSelectTask={id => setSelectedId(id)}
					/>
				</div>
			) : view === "board" ? (
				<div className="gui-taskcenter-body">
					<TaskBoardView
						tasks={tasks}
						onSelectTask={id => setSelectedId(id)}
						onToggle={id => {
							const task = tasks.find(x => x.id === id);
							if (!task || !rpc) return;
							void rpc
								.request("cron.update", { task: { ...task, enabled: !task.enabled } })
								.then(() => refresh())
								.catch(() => {});
						}}
						onDelete={id => {
							const task = tasks.find(x => x.id === id);
							if (task) setDeleteTarget(task);
						}}
					/>
				</div>
			) : tasks.length === 0 ? (
				<div className="gui-scheduled-empty">
					<div className="gui-scheduled-empty-icon">⏰</div>
					<div className="gui-scheduled-empty-title">{t("scheduled empty title")}</div>
					<div className="gui-scheduled-empty-desc">{t("scheduled empty desc")}</div>
					<button
						type="button"
						className="gui-btn gui-scheduled-new"
						onClick={() =>
							setDraft({
								id: "",
								name: "",
								enabled: true,
								schedule: { kind: "daily", times: ["09:00"], timezone: "Asia/Shanghai" },
								prompt: "",
								cwd: "",
								thinkingLevel: "default",
								state: { createdAt: Date.now() },
							})
						}
					>
						<Icon name="add" className="h-4 w-4" />
						<span>{t("scheduled new")}</span>
					</button>
				</div>
			) : (
				<div className="gui-scheduled-body">
					{/* Workspace columns (openchamber parity) */}
					<div className="gui-scheduled-ws">
						{groups.map(group => (
							<div key={group.cwd} className="gui-scheduled-ws-block">
								<div className="gui-scheduled-ws-head">
									<Icon name="folder-3" className="h-3.5 w-3.5" />
									<span className="min-w-0 flex-1 truncate">
										{group.cwd === "~" ? "~" : (group.cwd.split("/").filter(Boolean).at(-1) ?? group.cwd)}
									</span>
									<span className="gui-scheduled-ws-count">{group.tasks.length}</span>
								</div>
								{group.tasks.map(task => (
									<button
										key={task.id}
										type="button"
										className={`gui-scheduled-row${selected?.id === task.id ? " gui-scheduled-row--active" : ""}`}
										onClick={() => setSelectedId(task.id)}
									>
										<span className="gui-scheduled-row-dot" />
										<span className="min-w-0 flex-1 truncate">{task.name || t("scheduled untitled")}</span>
										{!task.enabled && <Icon name="pause" className="h-3 w-3 shrink-0 opacity-50" />}
									</button>
								))}
							</div>
						))}
					</div>
					{/* Detail panel (openchamber parity) */}
					<div className="gui-scheduled-detail">
						{selected ? (
							<>
								<h3 className="gui-scheduled-detail-title">{selected.name || t("scheduled untitled")}</h3>
								<div className="gui-scheduled-detail-sched">{scheduleLabel(selected.schedule)}</div>
								<div className="gui-scheduled-detail-status">
									<span className="gui-scheduled-detail-status-item">
										<Icon name="time" className="h-3.5 w-3.5" />
										<span className="gui-scheduled-detail-status-key">{t("scheduled next")}</span>
										<span className="gui-scheduled-detail-status-val">
											{selected.state.nextRunAt ? fmtRelative(selected.state.nextRunAt) : "—"}
											{selected.state.nextRunAt ? ` · ${fmtTime(selected.state.nextRunAt)}` : ""}
										</span>
									</span>
									<span className="gui-scheduled-detail-status-item">
										<Icon name="check" className="h-3.5 w-3.5" />
										<span className="gui-scheduled-detail-status-key">{t("scheduled last")}</span>
										{selected.state.lastStatus ? (
											<span className={`gui-cron-status ${STATUS_CLASS[selected.state.lastStatus] ?? ""}`}>
												{t(`scheduled status ${selected.state.lastStatus}` as never)}
											</span>
										) : (
											<span className="gui-scheduled-detail-status-val">—</span>
										)}
										{selected.state.lastRunAt ? (
											<span className="gui-scheduled-detail-status-val">
												{" "}
												· {fmtRelative(selected.state.lastRunAt)}
											</span>
										) : null}
									</span>
								</div>
								<div className="gui-scheduled-detail-enabled">
									<label className="gui-cron-toggle">
										<input type="checkbox" checked={selected.enabled} onChange={() => toggle(selected)} />
										<span className="gui-cron-toggle-track" />
									</label>
									<span>{t("scheduled enabled")}</span>
								</div>
								<div className="gui-scheduled-detail-prompt">
									<span className="gui-scheduled-detail-status-key">{t("scheduled prompt")}</span>
									<p className="gui-scheduled-detail-prompt-text">{selected.prompt || "—"}</p>
								</div>
								<div className="gui-scheduled-detail-actions">
									<button
										type="button"
										className="gui-btn gui-scheduled-run-now"
										onClick={() => runNow(selected.id)}
									>
										<Icon name="play" className="h-4 w-4 oc-icon-nudge" />
										<span>{t("scheduled run now")}</span>
									</button>
									{onOpenSession && selected.state.lastSessionId ? (
										<button
											type="button"
											className="gui-btn"
											onClick={() => onOpenSession(selected.state.lastSessionId!)}
											title={t("scheduled open session")}
										>
											<Icon name="external-link" className="h-4 w-4" />
											<span>{t("scheduled open session")}</span>
										</button>
									) : null}
									<button
										type="button"
										className="gui-btn"
										onClick={() => setDraft({ ...selected, schedule: { ...selected.schedule } })}
									>
										<Icon name="pencil" className="h-4 w-4" />
										<span>{t("board edit")}</span>
									</button>
									<button
										type="button"
										className="gui-btn gui-scheduled-del"
										onClick={() => {
											// Pull the freshest task state first so the dialog's
											// session count includes just-finished runs.
											if (!rpc) {
												setDeleteTarget(selected);
												return;
											}
											void rpc.request("cron.list").then(res => {
												const r = res as { tasks?: CronTask[]; runs?: CronRun[] } | null;
												if (r?.tasks) setTasks(r.tasks);
												if (r?.runs) setRuns(r.runs);
												const fresh = (r?.tasks ?? []).find(t => t.id === selected.id);
												setDeleteTarget(fresh ?? selected);
											});
										}}
									>
										<Icon name="delete-bin" className="h-4 w-4" />
										<span>{t("board remove")}</span>
									</button>
								</div>
							</>
						) : (
							<div className="gui-scheduled-empty gui-scheduled-detail-empty">
								<div className="gui-scheduled-empty-icon">⏰</div>
								<div className="gui-scheduled-empty-title">{t("scheduled detail empty")}</div>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Always mounted — DialogFrame drives enter/exit via `open` (Pop
			 * parity); data falls back to the last non-null task during the
			 * exit frame. */}
			<CronEditor
				open={draft !== null}
				rpc={rpc}
				task={editorTask ?? EMPTY_TASK}
				busy={busy}
				onCancel={() => setDraft(null)}
				onSave={save}
			/>
			<DeleteConfirmDialog
				open={deleteTarget !== null}
				task={deleteTask ?? EMPTY_TASK}
				sessionCount={taskSessionIds(deleteTask ?? EMPTY_TASK).length}
				busy={busy}
				onCancel={() => setDeleteTarget(null)}
				onConfirm={cleanup => remove((deleteTask ?? EMPTY_TASK).id, cleanup)}
			/>
		</div>
	);
}

/* ── Working-directory picker (openchamber project-menu parity) ──── */
function CwdPicker({ value, onChange }: { value: string; onChange(cwd: string): void }): ReactNode {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const projects = useMemo(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-projects");
			const arr = raw ? (JSON.parse(raw) as string[]) : [];
			return [...new Set(arr.filter((x): x is string => typeof x === "string" && x.length > 0))];
		} catch {
			return [];
		}
	}, []);
	const matches = query.trim() ? projects.filter(p => p.toLowerCase().includes(query.trim().toLowerCase())) : projects;
	return (
		<div className="gui-calendar-wrap">
			<button
				ref={anchorRef}
				type="button"
				className="gui-calendar-field"
				onClick={() => setOpen(o => !o)}
				aria-expanded={open}
			>
				<Icon name="folder-3" className="h-4 w-4" />
				<span className="gui-calendar-field-text">{value || t("scheduled cwd placeholder")}</span>
				<Icon name="arrow-down-s" className="h-4 w-4" />
			</button>
			<MenuPopup
				open={open}
				className="gui-cwd-pop"
				portal
				anchor={anchorRef.current}
				align="left"
				onOpenChange={setOpen}
			>
				<input
					autoFocus
					className="gui-task-input"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder={t("scheduled cwd search")}
				/>
				<div className="gui-cwd-list">
					{matches.map(p => (
						<button
							key={p}
							type="button"
							className={`gui-cwd-item${value === p ? " gui-cwd-item--active" : ""}`}
							onClick={() => {
								onChange(p);
								setOpen(false);
								setQuery("");
							}}
						>
							<Icon name="folder-3" className="h-3.5 w-3.5" />
							<span className="min-w-0 flex-1 truncate">{p}</span>
						</button>
					))}
					{matches.length === 0 && <span className="gui-cwd-empty">{t("scheduled cwd empty")}</span>}
				</div>
			</MenuPopup>
		</div>
	);
}

/* ── Calendar picker (openchamber one-off parity) ────────────────── */

/** Floating date-picker input (openchamber parity): a text-like field
 *  with calendar icon + chevron that opens a dropdown calendar; the
 *  calendar grid starts on the settings-page week start, not Sunday. */
function CalendarPicker({ value, onChange }: { value?: string; onChange(date: string): void }): ReactNode {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const selected = value ? new Date(`${value}T00:00:00`) : null;
	const [month, setMonth] = useState<Date>(() => {
		const base = selected ?? new Date();
		return new Date(base.getFullYear(), base.getMonth(), 1);
	});
	const today = new Date();
	const year = month.getFullYear();
	const mon = month.getMonth();
	const start = weekStartIndex();
	const firstWeekday = new Date(year, mon, 1).getDay();
	const leadDays = (firstWeekday - start + 7) % 7;
	const cells: Array<{ day: number; inMonth: boolean; date: Date }> = [];
	for (let i = 0; i < 42; i++) {
		const offset = i - leadDays + 1;
		const d = new Date(year, mon, offset);
		cells.push({ day: d.getDate(), inMonth: d.getMonth() === mon, date: d });
	}
	const iso = (d: Date): string =>
		`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	const isSel = (d: Date): boolean => selected !== null && iso(d) === iso(selected);
	const isToday = (d: Date): boolean => iso(d) === iso(today);
	const fmt = (d: Date): string => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
	const pick = (date: string): void => {
		onChange(date);
		setOpen(false);
	};
	return (
		<div className="gui-calendar-wrap">
			<button
				ref={anchorRef}
				type="button"
				className="gui-calendar-field"
				onClick={() => setOpen(o => !o)}
				aria-expanded={open}
			>
				<Icon name="calendar-schedule" className="h-4 w-4" />
				<span className="gui-calendar-field-text">{selected ? fmt(selected) : t("scheduled pick date")}</span>
				<Icon name="arrow-down-s" className="h-4 w-4" />
			</button>
			<MenuPopup
				open={open}
				className="gui-calendar-pop"
				portal
				anchor={anchorRef.current}
				align="left"
				onOpenChange={setOpen}
			>
				<div className="gui-calendar">
					<div className="gui-calendar-head">
						<button
							type="button"
							className="gui-calendar-nav"
							onClick={() => setMonth(new Date(year, mon - 1, 1))}
							aria-label={t("scheduled prev month")}
						>
							<Icon name="arrow-left-s" className="h-4 w-4" />
						</button>
						<span className="gui-calendar-month">
							{year}年{mon + 1}月
						</span>
						<button
							type="button"
							className="gui-calendar-nav"
							onClick={() => setMonth(new Date(year, mon + 1, 1))}
							aria-label={t("scheduled next month")}
						>
							<Icon name="arrow-right-s" className="h-4 w-4" />
						</button>
					</div>
					<div className="gui-calendar-grid">
						{orderedWeekdayKeys().map(k => (
							<span key={k} className="gui-calendar-dow">
								{t(k as never)}
							</span>
						))}
						{cells.map((c, i) => (
							<button
								key={i}
								type="button"
								className={`gui-calendar-day${c.inMonth ? "" : " gui-calendar-day--out"}${isSel(c.date) ? " gui-calendar-day--sel" : ""}${isToday(c.date) ? " gui-calendar-day--today" : ""}`}
								onClick={() => pick(iso(c.date))}
							>
								{c.day}
							</button>
						))}
					</div>
					<div className="gui-calendar-foot">
						<button type="button" className="gui-btn" onClick={() => pick(iso(today))}>
							{t("scheduled today")}
						</button>
						<button
							type="button"
							className="gui-btn"
							onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}
						>
							{t("scheduled jump today")}
						</button>
					</div>
				</div>
			</MenuPopup>
		</div>
	);
}

/* ── Editor dialog (openchamber two-column parity) ───────────────── */

function CronEditor({
	open,
	rpc,
	task,
	busy,
	onCancel,
	onSave,
}: {
	open: boolean;
	rpc?: { request(method: string, params?: Record<string, unknown>): Promise<unknown> };
	task: CronTask;
	busy: boolean;
	onCancel(): void;
	onSave(task: CronTask): void;
}): ReactNode {
	const [draft, setDraft] = useState<CronTask>(() => ({
		...task,
		schedule: { ...task.schedule, times: task.schedule.times ? [...task.schedule.times] : undefined },
	}));
	const [models, setModels] = useState<Array<{ id: string; provider: string; name?: string }>>([]);
	const [cronPreview, setCronPreview] = useState<string[]>([]);
	const patch = (p: Partial<CronTask>): void => setDraft(prev => ({ ...prev, ...p }));
	const patchSchedule = (p: Partial<CronSchedule>): void =>
		setDraft(prev => ({ ...prev, schedule: { ...prev.schedule, ...p } }));
	const kind = draft.schedule.kind;
	const times = draft.schedule.times?.length
		? draft.schedule.times
		: draft.schedule.time
			? [draft.schedule.time]
			: ["09:00"];

	// Model list (models.listAvailable — welcome-composer parity).
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request("models.listAvailable")
			.then(list => {
				const arr = (list ?? []) as Array<{ id: string; provider?: string; name?: string }>;
				if (alive) setModels(arr.map(m => ({ id: m.id, provider: m.provider ?? "", name: m.name ?? m.id })));
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);

	// Cron next-run preview: naive 5-field expansion (matches the daemon's
	// minimal parser; unknown tokens → no preview).
	useEffect(() => {
		const expr = (draft.schedule.cron ?? "").trim();
		if (kind !== "cron" || !expr) {
			setCronPreview([]);
			return;
		}
		setCronPreview(nextCronRuns(expr, 4));
	}, [kind, draft.schedule.cron]);

	const setTimes = (next: string[]): void => {
		patchSchedule({ times: next, time: next[0] });
	};

	return (
		<DialogFrame open={open} label={t("scheduled editor")} onClose={onCancel} className="gui-cron-dialog">
			<div className="gui-cron-form-scroll">
				<div className="gui-cron-form">
					<div className="gui-cron-form-grid">
						<div className="gui-cron-form-col">
							<div className="gui-widget-editor-field">
								<span className="gui-widget-editor-label">{t("scheduled name")} *</span>
								<input
									className="gui-task-input"
									value={draft.name}
									onChange={e => patch({ name: e.target.value })}
									placeholder={t("scheduled name placeholder")}
								/>
							</div>
							{kind === "daily" && (
								<div className="gui-widget-editor-field">
									<span className="gui-widget-editor-label">{t("scheduled times")}</span>
									{times.map((tm, i) => (
										<div key={i} className="gui-cron-time-row">
											<input
												className="gui-task-input"
												type="time"
												value={tm}
												onChange={e => {
													const next = [...times];
													next[i] = e.target.value;
													setTimes(next);
												}}
											/>
											{times.length > 1 && (
												<button
													type="button"
													className="gui-tool-btn"
													onClick={() => setTimes(times.filter((_, j) => j !== i))}
													title={t("scheduled remove time")}
													aria-label={t("scheduled remove time")}
												>
													<Icon name="delete-bin" className="h-3.5 w-3.5" />
												</button>
											)}
										</div>
									))}
									<button
										type="button"
										className="gui-cron-add-time"
										onClick={() => setTimes([...times, "12:00"])}
									>
										<Icon name="add" className="h-3.5 w-3.5" />
										<span>{t("scheduled add time")}</span>
									</button>
								</div>
							)}
							{(kind === "weekly" || kind === "monthly") && (
								<div className="gui-widget-editor-field">
									<span className="gui-widget-editor-label">{t("scheduled time")}</span>
									<input
										className="gui-task-input"
										type="time"
										value={draft.schedule.time ?? ""}
										onChange={e => patchSchedule({ time: e.target.value })}
									/>
								</div>
							)}
							{kind === "once" && (
								<div className="gui-widget-editor-field">
									<span className="gui-widget-editor-label">{t("scheduled time")}</span>
									<input
										className="gui-task-input"
										type="time"
										value={draft.schedule.time ?? ""}
										onChange={e => patchSchedule({ time: e.target.value })}
									/>
								</div>
							)}
							<div className="gui-widget-editor-field">
								<span className="gui-widget-editor-label">{t("scheduled model")}</span>
								<GuiSelect
									className="gui-settings-select"
									value={draft.model ?? ""}
									onChange={v => patch({ model: v || undefined })}
									options={[
										{ value: "", label: t("scheduled model default") },
										...models.map(m => ({ value: m.id, label: m.name ?? m.id })),
									]}
								/>
							</div>
							<div className="gui-widget-editor-field">
								<span className="gui-widget-editor-label">{t("scheduled prompt")} *</span>
								<textarea
									className="gui-task-input gui-widget-editor-textarea"
									rows={5}
									value={draft.prompt}
									onChange={e => patch({ prompt: e.target.value })}
									placeholder={t("scheduled prompt placeholder")}
								/>
							</div>
						</div>
						<div className="gui-cron-form-col">
							<div className="gui-widget-editor-field">
								<span className="gui-widget-editor-label">{t("scheduled type")}</span>
								<GuiSelect
									className="gui-settings-select"
									value={kind}
									onChange={v => patchSchedule({ kind: v as CronSchedule["kind"] })}
									options={[
										{ value: "once", label: t("scheduled type once") },
										{ value: "daily", label: t("scheduled type daily") },
										{ value: "weekly", label: t("scheduled type weekly") },
										{ value: "monthly", label: t("scheduled type monthly") },
										{ value: "cron", label: t("scheduled type cron") },
									]}
								/>
							</div>
							{kind === "once" && (
								<div className="gui-widget-editor-field">
									<span className="gui-widget-editor-label">{t("scheduled date")}</span>
									<CalendarPicker value={draft.schedule.date} onChange={date => patchSchedule({ date })} />
								</div>
							)}
							{kind === "weekly" && (
								<div className="gui-widget-editor-field">
									<span className="gui-widget-editor-label">{t("scheduled weekdays")}</span>
									<div className="gui-cron-weekdays">
										{orderedWeekdayKeys().map((key, i) => {
											const day = (weekStartIndex() + i) % 7;
											return (
												<button
													key={key}
													type="button"
													className={`gui-cron-weekday${(draft.schedule.weekdays ?? []).includes(day) ? " gui-cron-weekday--on" : ""}`}
													onClick={() => {
														const cur = new Set(draft.schedule.weekdays ?? []);
														if (cur.has(day)) cur.delete(day);
														else cur.add(day);
														patchSchedule({ weekdays: [...cur].sort() });
													}}
												>
													{t(key as never)}
												</button>
											);
										})}
									</div>
								</div>
							)}
							{kind === "monthly" && (
								<div className="gui-widget-editor-field">
									<span className="gui-widget-editor-label">{t("scheduled day of month")}</span>
									<input
										className="gui-task-input"
										type="number"
										min={1}
										max={31}
										value={draft.schedule.dayOfMonth ?? 1}
										onChange={e => patchSchedule({ dayOfMonth: Number(e.target.value) })}
									/>
								</div>
							)}
							{/* Idle-run window (闲时任务, proma activeWindow parity): the
							 * task only executes inside HH:mm–HH:mm (crosses midnight
							 * allowed) — heavy jobs wait for a quiet machine. */}
							<div className="gui-widget-editor-field">
								<span className="gui-widget-editor-label">{t("idle window")}</span>
								<div className="gui-cron-time-row">
									<input
										className="gui-task-input"
										type="time"
										value={draft.schedule.idleWindow?.start ?? ""}
										onChange={e =>
											patchSchedule({
												idleWindow: {
													start: e.target.value,
													end: draft.schedule.idleWindow?.end ?? "08:00",
												},
											})
										}
										aria-label={t("idle window start")}
									/>
									<span className="gui-cron-idle-sep">–</span>
									<input
										className="gui-task-input"
										type="time"
										value={draft.schedule.idleWindow?.end ?? ""}
										onChange={e =>
											patchSchedule({
												idleWindow: {
													start: draft.schedule.idleWindow?.start ?? "22:00",
													end: e.target.value,
												},
											})
										}
										aria-label={t("idle window end")}
									/>
									{draft.schedule.idleWindow && (
										<button
											type="button"
											className="gui-tool-btn"
											onClick={() => patchSchedule({ idleWindow: undefined })}
											title={t("idle window clear")}
											aria-label={t("idle window clear")}
										>
											<Icon name="delete-bin" className="h-3.5 w-3.5" />
										</button>
									)}
								</div>
								<div className="gui-cron-idle-hint">{t("idle window hint")}</div>
							</div>
							{kind === "cron" && (
								<>
									<div className="gui-widget-editor-field">
										<span className="gui-widget-editor-label">{t("scheduled cron")} *</span>
										<input
											className="gui-task-input gui-cron-expr"
											value={draft.schedule.cron ?? ""}
											onChange={e => patchSchedule({ cron: e.target.value })}
											placeholder="*/5 * * * *"
										/>
										{cronPreview.length > 0 && (
											<div className="gui-cron-preview">
												<span className="gui-widget-editor-hint">{t("scheduled next runs")}</span>
												<div className="gui-cron-preview-list">
													{cronPreview.map((r, i) => (
														<span key={i}>{r}</span>
													))}
												</div>
											</div>
										)}
									</div>
									<div className="gui-widget-editor-field">
										<span className="gui-widget-editor-label">{t("scheduled cron examples")}</span>
										<div className="gui-cron-examples">
											{CRON_EXAMPLES.map(ex => (
												<button
													key={ex.expr}
													type="button"
													className="gui-cron-example"
													onClick={() => patchSchedule({ cron: ex.expr })}
												>
													<code>{ex.expr}</code>
													<span>{t(ex.label as never)}</span>
												</button>
											))}
										</div>
									</div>
								</>
							)}
							<div className="gui-widget-editor-field">
								<span className="gui-widget-editor-label">{t("scheduled timezone")}</span>
								<GuiSelect
									className="gui-settings-select"
									value={draft.schedule.timezone ?? "Asia/Shanghai"}
									onChange={v => patchSchedule({ timezone: v })}
									options={TIMEZONES.map(tz => ({ value: tz, label: tz }))}
								/>
							</div>
							<div className="gui-widget-editor-field">
								<span className="gui-widget-editor-label">{t("scheduled thinking")}</span>
								<GuiSelect
									className="gui-settings-select"
									value={draft.thinkingLevel ?? "default"}
									onChange={v => patch({ thinkingLevel: v as CronTask["thinkingLevel"] })}
									options={[
										{ value: "default", label: t("scheduled thinking default") },
										{ value: "low", label: t("scheduled thinking low") },
										{ value: "medium", label: t("scheduled thinking medium") },
										{ value: "high", label: t("scheduled thinking high") },
									]}
								/>
							</div>
							<div className="gui-widget-editor-field">
								<span className="gui-widget-editor-label">{t("scheduled cwd")}</span>
								<CwdPicker value={draft.cwd} onChange={cwd => patch({ cwd })} />
							</div>
						</div>
					</div>
				</div>
			</div>
			<div className="gui-cron-form-foot">
				<label className="gui-cron-enabled">
					<input type="checkbox" checked={draft.enabled} onChange={e => patch({ enabled: e.target.checked })} />
					<span>{t("scheduled enabled")}</span>
				</label>
				<div className="gui-cron-form-actions">
					<button type="button" className="gui-btn" onClick={onCancel}>
						{t("cancel")}
					</button>
					<button
						type="button"
						className="gui-btn gui-scheduled-new"
						disabled={
							busy || !draft.name.trim() || !draft.prompt.trim() || (kind === "once" && !draft.schedule.date)
						}
						onClick={() => {
							const iw = draft.schedule.idleWindow;
							const clean =
								iw?.start.trim() && iw.end.trim() ? { start: iw.start.trim(), end: iw.end.trim() } : undefined;
							onSave({ ...draft, schedule: { ...draft.schedule, idleWindow: clean } });
						}}
					>
						{t("save")}
					</button>
				</div>
			</div>
		</DialogFrame>
	);
}

/** Naive 5-field cron next-run expansion — matches the daemon's minimal
 *  parser (Vixie dom/dow semantics, * step range list). */
function nextCronRuns(expr: string, count: number): string[] {
	const parts = expr.split(/\s+/);
	if (parts.length !== 5) return [];
	const field = (part: string): number[] | null => {
		if (part === "*") return null;
		if (/^\d+$/.test(part)) return [Number(part)];
		if (/^\*\/(\d+)$/.test(part)) {
			const step = Number(/^\*\/(\d+)$/.exec(part)?.[1] ?? 1);
			return step > 0 ? Array.from({ length: Math.floor(60 / step) }, (_, i) => i * step) : null;
		}
		if (/^\d+-\d+$/.test(part)) {
			const [a, b] = part.split("-").map(Number);
			if (a >= 0 && b >= a && b <= 59) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
			return null;
		}
		if (part.includes(",")) {
			const vals = part.split(",").map(Number);
			return vals.every(Number.isInteger) ? vals : null;
		}
		return null;
	};
	const mins = field(parts[0]);
	const hours = field(parts[1]);
	const doms = field(parts[2]);
	const months = field(parts[3]);
	const dows = field(parts[4]);
	const out: string[] = [];
	let d = new Date(Date.now() + 60_000);
	for (let i = 0; i < 366 * 24 * 60 && out.length < count; i++) {
		if (months && !months.includes(d.getMonth() + 1)) {
			d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
			continue;
		}
		const dowMatch = !dows || dows.includes(d.getDay());
		const domMatch = !doms || doms.includes(d.getDate());
		const dayMatch = !doms || !dows ? domMatch || dowMatch : domMatch && dowMatch;
		if (dayMatch && (!hours || hours.includes(d.getHours())) && (!mins || mins.includes(d.getMinutes()))) {
			out.push(
				`${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
			);
		}
		d = new Date(d.getTime() + 60_000);
	}
	return out;
}

/* ── Task-delete confirm with session disposition (delete / archive /
 *    keep) — the daemon removes sessions only on "delete". ───────── */
function DeleteConfirmDialog({
	open,
	task,
	sessionCount,
	busy,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	task: CronTask;
	sessionCount: number;
	busy: boolean;
	onCancel(): void;
	onConfirm(cleanup: "none" | "archive" | "delete"): void;
}): ReactNode {
	const [cleanup, setCleanup] = useState<"none" | "archive" | "delete">("none");
	return (
		<DialogFrame
			open={open}
			label={t("scheduled delete title")}
			onClose={onCancel}
			className="gui-cron-delete-dialog"
		>
			<div className="gui-cron-delete">
				<p className="gui-cron-delete-desc">
					{t("scheduled delete desc", { name: task.name || t("scheduled untitled") })}
				</p>
				{sessionCount > 0 && (
					<p className="gui-cron-delete-sessions">{t("scheduled delete sessions", { count: sessionCount })}</p>
				)}
				<div className="gui-cron-delete-opts">
					<label className="gui-cron-delete-opt">
						<input
							type="radio"
							name="cron-delete-cleanup"
							checked={cleanup === "none"}
							onChange={() => setCleanup("none")}
						/>
						<span>
							<strong>{t("scheduled delete keep")}</strong>
							<small>{t("scheduled delete keep desc")}</small>
						</span>
					</label>
					<label className="gui-cron-delete-opt">
						<input
							type="radio"
							name="cron-delete-cleanup"
							checked={cleanup === "archive"}
							onChange={() => setCleanup("archive")}
						/>
						<span>
							<strong>{t("scheduled delete archive")}</strong>
							<small>{t("scheduled delete archive desc")}</small>
						</span>
					</label>
					<label className="gui-cron-delete-opt">
						<input
							type="radio"
							name="cron-delete-cleanup"
							checked={cleanup === "delete"}
							onChange={() => setCleanup("delete")}
						/>
						<span>
							<strong>{t("scheduled delete delete")}</strong>
							<small>{t("scheduled delete delete desc")}</small>
						</span>
					</label>
				</div>
				<div className="gui-cron-form-actions">
					<button type="button" className="gui-btn" onClick={onCancel}>
						{t("cancel")}
					</button>
					<button
						type="button"
						className="gui-btn gui-scheduled-del"
						disabled={busy}
						onClick={() => onConfirm(cleanup)}
					>
						{t("board remove")}
					</button>
				</div>
			</div>
		</DialogFrame>
	);
}
