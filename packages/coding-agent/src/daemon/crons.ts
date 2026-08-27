import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Scheduled tasks store + scheduler (kimi cron + openchamber scheduled-task
 * parity): tasks live in ~/.musepi/crons.json, the daemon checks due runs
 * on an interval and executes each task's prompt in a fresh session bound
 * to the task's cwd. State (last run / next run / status) is persisted so
 * the GUI list survives restarts.
 */

export interface CronSchedule {
	kind: "once" | "daily" | "weekly" | "monthly" | "cron";
	/** HH:mm — daily / weekly / monthly */
	time?: string;
	/** HH:mm list — daily (openchamber parity: multiple fire times a day) */
	times?: string[];
	/** YYYY-MM-DD — once */
	date?: string;
	/** 0 (Sun) .. 6 (Sat) — weekly */
	weekdays?: number[];
	/** 1..31 — monthly */
	dayOfMonth?: number;
	/** cron expression (5 fields) — kind=cron */
	cron?: string;
	/**
	 * Idle-run window (proma activeWindow parity): HH:mm–HH:mm. A due run
	 * outside the window is deferred to the window's start (today if it
	 * hasn't opened yet, else tomorrow) — the "闲时任务" pattern where
	 * heavy jobs only run while the machine is quiet. Crosses midnight
	 * (22:00–08:00) supported.
	 */
	idleWindow?: { start: string; end: string };
	timezone?: string;
}

export type CronStatus = "idle" | "running" | "success" | "error";

export interface CronTask {
	id: string;
	name: string;
	enabled: boolean;
	schedule: CronSchedule;
	prompt: string;
	cwd: string;
	/** Task-level model id (openchamber parity); unset → session default. */
	model?: string;
	/** Task-level thinking effort; unset → session default. */
	thinkingLevel?: "default" | "low" | "medium" | "high";
	state: {
		createdAt: number;
		lastRunAt?: number;
		lastStatus?: CronStatus;
		lastError?: string;
		lastSessionId?: string;
		nextRunAt?: number;
	};
}

export interface CronRun {
	id: string;
	taskId: string;
	startedAt: number;
	finishedAt?: number;
	status: CronStatus;
	error?: string;
	sessionId?: string;
}

const MAX_PROMPT = 20_000;

export function cronStoragePath(): string {
	const dir = resolve(homedir(), ".musepi");
	mkdirSync(dir, { recursive: true });
	return resolve(dir, "crons.json");
}

export function loadCronTasks(): CronTask[] {
	try {
		const raw = readFileSync(cronStoragePath(), "utf8");
		const parsed = JSON.parse(raw) as { tasks?: CronTask[] };
		if (!Array.isArray(parsed.tasks)) return [];
		return parsed.tasks.map(sanitizeCronTask).filter((t): t is CronTask => t !== null);
	} catch {
		return [];
	}
}

export function saveCronTasks(tasks: CronTask[]): void {
	writeFileSync(cronStoragePath(), JSON.stringify({ tasks }, null, 2), "utf8");
}

/** Persist run history (bounded): crons.runs.json, newest 100 runs. */
export function loadCronRuns(): CronRun[] {
	try {
		const raw = readFileSync(resolve(homedir(), ".musepi", "crons.runs.json"), "utf8");
		const parsed = JSON.parse(raw) as { runs?: CronRun[] };
		if (!Array.isArray(parsed.runs)) return [];
		return parsed.runs;
	} catch {
		return [];
	}
}

export function saveCronRuns(runs: CronRun[]): void {
	const bounded = runs.slice(-100);
	writeFileSync(resolve(homedir(), ".musepi", "crons.runs.json"), JSON.stringify({ runs: bounded }, null, 2), "utf8");
}

function sanitizeCronTask(t: unknown): CronTask | null {
	if (!t || typeof t !== "object") return null;
	const o = t as Record<string, unknown>;
	if (typeof o.id !== "string" || typeof o.name !== "string" || typeof o.prompt !== "string") return null;
	const schedule = (o.schedule ?? {}) as Record<string, unknown>;
	const kind = schedule.kind;
	if (typeof kind !== "string" || !["once", "daily", "weekly", "monthly", "cron"].includes(kind)) return null;
	return {
		id: o.id,
		name: o.name,
		enabled: o.enabled !== false,
		schedule: {
			kind: kind as CronSchedule["kind"],
			time: typeof schedule.time === "string" ? schedule.time : undefined,
			times: Array.isArray(schedule.times)
				? schedule.times.filter((x): x is string => typeof x === "string")
				: undefined,
			date: typeof schedule.date === "string" ? schedule.date : undefined,
			weekdays: Array.isArray(schedule.weekdays)
				? schedule.weekdays.filter((d): d is number => typeof d === "number")
				: undefined,
			dayOfMonth: typeof schedule.dayOfMonth === "number" ? schedule.dayOfMonth : undefined,
			cron: typeof schedule.cron === "string" ? schedule.cron : undefined,
			timezone: typeof schedule.timezone === "string" ? schedule.timezone : undefined,
		},
		prompt: o.prompt,
		cwd: typeof o.cwd === "string" ? o.cwd : process.cwd(),
		model: typeof o.model === "string" && o.model ? o.model : undefined,
		thinkingLevel: ["default", "low", "medium", "high"].includes(o.thinkingLevel as string)
			? (o.thinkingLevel as CronTask["thinkingLevel"])
			: undefined,
		state: (() => {
			const st = (o.state ?? {}) as Record<string, unknown>;
			return {
				createdAt: typeof st.createdAt === "number" ? st.createdAt : Date.now(),
				lastRunAt: typeof st.lastRunAt === "number" ? (st.lastRunAt as number) : undefined,
				lastStatus: typeof st.lastStatus === "string" ? (st.lastStatus as CronStatus) : undefined,
				lastError: typeof st.lastError === "string" ? (st.lastError as string) : undefined,
				lastSessionId: typeof st.lastSessionId === "string" ? (st.lastSessionId as string) : undefined,
				nextRunAt: typeof st.nextRunAt === "number" ? (st.nextRunAt as number) : undefined,
			};
		})(),
	};
}

export function validateCronTask(t: unknown): { ok: boolean; error?: string } {
	if (!t || typeof t !== "object") return { ok: false, error: "task required" };
	const o = t as Record<string, unknown>;
	if (typeof o.name !== "string" || !o.name.trim()) return { ok: false, error: "name required" };
	if (typeof o.prompt !== "string" || !o.prompt.trim()) return { ok: false, error: "prompt required" };
	if (o.prompt.length > MAX_PROMPT) return { ok: false, error: `prompt too long (> ${MAX_PROMPT})` };
	const s = (o.schedule ?? {}) as Record<string, unknown>;
	const kind = s.kind;
	if (typeof kind !== "string" || !["once", "daily", "weekly", "monthly", "cron"].includes(kind)) {
		return { ok: false, error: `schedule.kind must be once|daily|weekly|monthly|cron` };
	}
	if (kind === "once" && typeof s.date !== "string")
		return { ok: false, error: "once schedule needs date (YYYY-MM-DD)" };
	if (kind === "daily") {
		const times = Array.isArray(s.times) && s.times.length > 0 ? s.times : s.time ? [s.time] : null;
		if (!times || times.some(x => !parseTime(x))) return { ok: false, error: "daily schedule needs time(s) (HH:mm)" };
	}
	if (kind !== "once" && kind !== "daily" && typeof s.time !== "string")
		return { ok: false, error: "schedule needs time (HH:mm)" };
	if (kind === "weekly" && !Array.isArray(s.weekdays)) return { ok: false, error: "weekly schedule needs weekdays" };
	if (kind === "monthly" && typeof s.dayOfMonth !== "number")
		return { ok: false, error: "monthly schedule needs dayOfMonth" };
	if (kind === "cron" && typeof s.cron !== "string")
		return { ok: false, error: "cron schedule needs cron expression" };
	return { ok: true };
}

function parseTime(time: string): { h: number; m: number } | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (!match) return null;
	const h = Number(match[1]);
	const min = Number(match[2]);
	if (h < 0 || h > 23 || min < 0 || min > 59) return null;
	return { h, m: min };
}

function atLocal(date: Date, h: number, m: number): number {
	const d = new Date(date);
	d.setHours(h, m, 0, 0);
	return d.getTime();
}

/** Next run (epoch ms) after `from`; null when the schedule never fires again. */
export function computeNextRun(task: CronTask, from: number): number | null {
	// Defer a raw due run into the task's idle window (闲时任务) — the
	// constraint applies to every schedule kind uniformly.
	const raw = computeNextRunRaw(task, from);
	if (raw === null) return null;
	return constrainToIdleWindow(raw, task.schedule.idleWindow, from);
}

function computeNextRunRaw(task: CronTask, from: number): number | null {
	const s = task.schedule;
	const t = s.time ? parseTime(s.time) : null;
	if (s.kind === "once") {
		if (!s.date) return null;
		const target = new Date(`${s.date}T${s.time ?? "00:00"}:00`).getTime();
		return Number.isNaN(target) ? null : target > from ? target : null;
	}
	if (s.kind === "daily") {
		// openchamber parity: daily tasks fire at every configured time.
		const times = (s.times?.length ? s.times : s.time ? [s.time] : [])
			.map(parseTime)
			.filter((x): x is { h: number; m: number } => x !== null);
		if (times.length === 0) return null;
		for (let i = 0; i < 32; i++) {
			const d = new Date(from + i * 24 * 60 * 60 * 1000);
			for (const { h, m } of times) {
				const at = atLocal(d, h, m);
				if (at > from) return at;
			}
		}
		return null;
	}
	if (s.kind === "weekly") {
		if (!t || !Array.isArray(s.weekdays)) return null;
		const days = new Set(s.weekdays);
		let d = new Date(from);
		for (let i = 0; i < 14; i++) {
			if (days.has(d.getDay())) {
				const at = atLocal(d, t.h, t.m);
				if (at > from) return at;
			}
			d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
		}
		return null;
	}
	if (s.kind === "monthly") {
		if (!t || typeof s.dayOfMonth !== "number") return null;
		let d = new Date(from);
		for (let i = 0; i < 62; i++) {
			if (d.getDate() === s.dayOfMonth) {
				const at = atLocal(d, t.h, t.m);
				if (at > from) return at;
			}
			d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
		}
		return null;
	}
	if (s.kind === "cron") {
		// Minimal 5-field cron (min hour dom mon dow) — enough for the
		// openchamber examples and common agent schedules. Full
		// cron-parser is out of scope for the daemon bundle; unknown
		// tokens fall back to the next day boundary.
		const expr = (s.cron ?? "").trim().split(/\s+/);
		if (expr.length !== 5) return null;
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
		const mins = field(expr[0]);
		const hours = field(expr[1]);
		const doms = field(expr[2]);
		const months = field(expr[3]);
		const dows = field(expr[4]);
		let d = new Date(from + 60_000);
		// Scan up to a full year ahead at 1-minute steps (cheap enough in
		// JS); weekly/monthly crons need multi-day lookahead.
		for (let i = 0; i < 366 * 24 * 60; i++) {
			if (months && !months.includes(d.getMonth() + 1)) {
				d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
				continue;
			}
			const dowMatch = !dows || dows.includes(d.getDay());
			const domMatch = !doms || doms.includes(d.getDate());
			// Vixie semantics: when BOTH dom and dow are constrained they
			// AND; a wildcard on either side turns it into OR.
			const dayMatch = !doms || !dows ? domMatch || dowMatch : domMatch && dowMatch;
			if (dayMatch && (!hours || hours.includes(d.getHours())) && (!mins || mins.includes(d.getMinutes()))) {
				const at = d.getTime();
				if (at > from) return at;
			}
			d = new Date(d.getTime() + 60_000);
		}
		return null;
	}
	return null;
}

/**
 * Defer a due run into the task's idle window (闲时任务, proma
 * activeWindow parity): runs outside the window move to the window's
 * start — today if it hasn't opened yet, otherwise the next occurrence.
 * A window crossing midnight (22:00–08:00) is two intervals (start→24:00
 * and 00:00→end). No window → unchanged.
 */
export function constrainToIdleWindow(
	at: number,
	window: CronSchedule["idleWindow"] | undefined,
	from: number,
): number {
	if (!window) return at;
	const start = parseTime(window.start);
	const end = parseTime(window.end);
	if (!start || !end) return at;
	const atDate = new Date(at);
	const dayStart = new Date(atDate.getFullYear(), atDate.getMonth(), atDate.getDate());
	const startMs = dayStart.getTime() + (start.h * 60 + start.m) * 60_000;
	const endMs = dayStart.getTime() + (end.h * 60 + end.m) * 60_000;
	const day = 24 * 60 * 60_000;
	if (startMs <= endMs) {
		// Same-day window (09:00–18:00).
		if (at < startMs) return startMs;
		if (at <= endMs) return at;
		return startMs + day; // window closed → next occurrence's start
	}
	// Crosses midnight (22:00–08:00).
	if (at >= startMs) return at; // 22:00–24:00 leg
	if (at <= endMs) return at; // 00:00–08:00 leg
	// In the daytime gap: the nearest window start measured from `from`
	// (today's opening if still ahead, else tomorrow's) — anchoring on
	// `at`'s date would skip a same-day opening that is closer.
	const fromDate = new Date(from);
	const fromDayStart = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()).getTime();
	const fromStartMs = fromDayStart + (start.h * 60 + start.m) * 60_000;
	return fromStartMs > from ? fromStartMs : fromStartMs + day;
}
