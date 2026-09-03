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
	/**
	 * IANA timezone the schedule's wall-clock times are interpreted in.
	 * Unset/unknown → the daemon host's local timezone.
	 */
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

export function validateCronSchedule(s: unknown): { ok: boolean; error?: string } {
	if (!s || typeof s !== "object") return { ok: false, error: "schedule required" };
	const kind = (s as Record<string, unknown>).kind;
	if (typeof kind !== "string" || !["once", "daily", "weekly", "monthly", "cron"].includes(kind)) {
		return { ok: false, error: `schedule.kind must be once|daily|weekly|monthly|cron` };
	}
	const o = s as Record<string, unknown>;
	if (kind === "once" && typeof o.date !== "string")
		return { ok: false, error: "once schedule needs date (YYYY-MM-DD)" };
	if (kind === "daily") {
		const times = Array.isArray(o.times) && o.times.length > 0 ? o.times : o.time ? [o.time] : null;
		if (!times || times.some(x => !parseTime(x as string))) {
			return { ok: false, error: "daily schedule needs time(s) (HH:mm)" };
		}
	}
	if (kind !== "once" && kind !== "daily" && typeof o.time !== "string") {
		return { ok: false, error: "schedule needs time (HH:mm)" };
	}
	if (kind === "weekly" && !Array.isArray(o.weekdays)) return { ok: false, error: "weekly schedule needs weekdays" };
	if (kind === "monthly" && typeof o.dayOfMonth !== "number") {
		return { ok: false, error: "monthly schedule needs dayOfMonth" };
	}
	if (kind === "cron" && typeof o.cron !== "string")
		return { ok: false, error: "cron schedule needs cron expression" };
	if (typeof o.timezone === "string" && o.timezone && !isValidTimeZone(o.timezone)) {
		return { ok: false, error: `unknown timezone "${o.timezone}"` };
	}
	return { ok: true };
}

export function validateCronTask(t: unknown): { ok: boolean; error?: string } {
	if (!t || typeof t !== "object") return { ok: false, error: "task required" };
	const o = t as Record<string, unknown>;
	if (typeof o.name !== "string" || !o.name.trim()) return { ok: false, error: "name required" };
	if (typeof o.prompt !== "string" || !o.prompt.trim()) return { ok: false, error: "prompt required" };
	if (o.prompt.length > MAX_PROMPT) return { ok: false, error: `prompt too long (> ${MAX_PROMPT})` };
	return validateCronSchedule(o.schedule);
}

/**
 * Create/merge path shared by the daemon and collab-host cron.upsert RPCs.
 * NEW tasks use an explicit field whitelist — `model`/`thinkingLevel` must
 * be carried here or the editor's selections are silently dropped on
 * create; edits spread-merge over the stored task. `nextRunAt` is
 * recomputed from `now` (cleared when disabled).
 */
export function mergeCronTask(existing: CronTask | undefined, t: CronTask, now: number, defaultCwd: string): CronTask {
	const merged: CronTask = existing
		? { ...existing, ...t, state: { ...existing.state, ...t.state } }
		: {
				id: t.id && /^[a-z0-9-]+$/i.test(t.id) ? t.id : `cron-${now.toString(36)}`,
				name: t.name,
				enabled: t.enabled !== false,
				schedule: t.schedule,
				prompt: t.prompt,
				cwd: t.cwd || defaultCwd,
				model: t.model,
				thinkingLevel: t.thinkingLevel,
				state: { ...t.state, createdAt: now },
			};
	merged.state.nextRunAt = merged.enabled ? (computeNextRun(merged, now) ?? undefined) : undefined;
	return merged;
}

function parseTime(time: string): { h: number; m: number } | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (!match) return null;
	const h = Number(match[1]);
	const min = Number(match[2]);
	if (h < 0 || h > 23 || min < 0 || min > 59) return null;
	return { h, m: min };
}

/* ── Timezone helpers (DST-safe wall-clock ↔ epoch) ──────────────────── */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormat(tz: string): Intl.DateTimeFormat {
	let f = dtfCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
		dtfCache.set(tz, f);
	}
	return f;
}

const validTzCache = new Map<string, boolean>();

/** True when the string is a timezone Intl can schedule in. */
export function isValidTimeZone(tz: string): boolean {
	const cached = validTzCache.get(tz);
	if (cached !== undefined) return cached;
	let ok = false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		ok = true;
	} catch {
		ok = false;
	}
	validTzCache.set(tz, ok);
	return ok;
}

interface CalendarDay {
	y: number;
	m: number;
	d: number;
	dow: number;
}

/** Wall-clock Y/M/D + weekday of `at` in `tz` (host-local when undefined). */
function zonedDayParts(at: number, tz: string | undefined): CalendarDay {
	if (!tz) {
		const d = new Date(at);
		return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), dow: d.getDay() };
	}
	let y = 1970;
	let m = 1;
	let d = 1;
	for (const p of zonedFormat(tz).formatToParts(at)) {
		if (p.type === "year") y = Number(p.value);
		else if (p.type === "month") m = Number(p.value);
		else if (p.type === "day") d = Number(p.value);
	}
	// Weekday of the calendar date — zone-independent by definition.
	const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return { y, m, d, dow };
}

/** Offset (ms east of UTC) of `tz` at `epoch`, from its formatted wall clock. */
function zonedOffsetMs(epoch: number, tz: string): number {
	const second = Math.floor(epoch / 1000) * 1000;
	let y = 1970;
	let mo = 1;
	let d = 1;
	let h = 0;
	let mi = 0;
	let s = 0;
	for (const p of zonedFormat(tz).formatToParts(second)) {
		if (p.type === "year") y = Number(p.value);
		else if (p.type === "month") mo = Number(p.value);
		else if (p.type === "day") d = Number(p.value);
		else if (p.type === "hour") h = Number(p.value);
		else if (p.type === "minute") mi = Number(p.value);
		else if (p.type === "second") s = Number(p.value);
	}
	return Date.UTC(y, mo - 1, d, h, mi, s) - second;
}

/** Epoch ms of wall-clock Y-M-D h:mm in `tz` (host-local when undefined).
 *  Two-step offset correction survives DST transitions; wall times inside
 *  a spring-forward gap resolve to the nearest forward instant. */
function zonedTimeToEpoch(y: number, m: number, d: number, h: number, min: number, tz: string | undefined): number {
	if (!tz) return new Date(y, m - 1, d, h, min).getTime();
	const guess = Date.UTC(y, m - 1, d, h, min);
	const off1 = zonedOffsetMs(guess, tz);
	let at = guess - off1;
	const off2 = zonedOffsetMs(at, tz);
	if (off2 !== off1) at = guess - off2;
	return at;
}

/** Calendar day `i` days after the anchor day — a pure date computation
 *  (Date.UTC arithmetic), so day walks never repeat or skip around DST. */
function calendarDay(anchor: CalendarDay, i: number): CalendarDay {
	const t = new Date(Date.UTC(anchor.y, anchor.m - 1, anchor.d + i));
	return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

/* ── Next-run computation ───────────────────────────────────────────── */

/** Next run (epoch ms) after `from`; null when the schedule never fires again. */
export function computeNextRun(task: Pick<CronTask, "schedule">, from: number): number | null {
	// Defer a raw due run into the task's idle window (闲时任务) — the
	// constraint applies to every schedule kind uniformly.
	const raw = computeNextRunRaw(task.schedule, from);
	if (raw === null) return null;
	return constrainToIdleWindow(raw, task.schedule.idleWindow, from, task.schedule.timezone);
}

function computeNextRunRaw(s: CronSchedule, from: number): number | null {
	const tz = s.timezone && isValidTimeZone(s.timezone) ? s.timezone : undefined;
	if (s.kind === "once") {
		if (!s.date) return null;
		const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.date);
		const tm = parseTime(s.time ?? "00:00");
		if (!dm || !tm) return null;
		const target = zonedTimeToEpoch(Number(dm[1]), Number(dm[2]), Number(dm[3]), tm.h, tm.m, tz);
		return target > from ? target : null;
	}
	if (s.kind === "daily") {
		// openchamber parity: daily tasks fire at every configured time.
		const times = (s.times?.length ? s.times : s.time ? [s.time] : [])
			.map(parseTime)
			.filter((x): x is { h: number; m: number } => x !== null);
		if (times.length === 0) return null;
		const anchor = zonedDayParts(from, tz);
		for (let i = 0; i < 32; i++) {
			const day = calendarDay(anchor, i);
			for (const { h, m } of times) {
				const at = zonedTimeToEpoch(day.y, day.m, day.d, h, m, tz);
				if (at > from) return at;
			}
		}
		return null;
	}
	if (s.kind === "weekly") {
		const t = parseTime(s.time ?? "");
		if (!t || !Array.isArray(s.weekdays)) return null;
		const days = new Set(s.weekdays);
		const anchor = zonedDayParts(from, tz);
		for (let i = 0; i < 14; i++) {
			const day = calendarDay(anchor, i);
			if (days.has(day.dow)) {
				const at = zonedTimeToEpoch(day.y, day.m, day.d, t.h, t.m, tz);
				if (at > from) return at;
			}
		}
		return null;
	}
	if (s.kind === "monthly") {
		const t = parseTime(s.time ?? "");
		if (!t || typeof s.dayOfMonth !== "number") return null;
		const anchor = zonedDayParts(from, tz);
		for (let i = 0; i < 62; i++) {
			const day = calendarDay(anchor, i);
			if (day.d === s.dayOfMonth) {
				const at = zonedTimeToEpoch(day.y, day.m, day.d, t.h, t.m, tz);
				if (at > from) return at;
			}
		}
		return null;
	}
	if (s.kind === "cron") {
		// Minimal 5-field cron (min hour dom mon dow) — enough for the
		// openchamber examples and common agent schedules. Full
		// cron-parser is out of scope for the daemon bundle; unknown
		// tokens fall back to wildcard. Expanded per calendar day in the
		// task's timezone (Vixie dom/dow AND/OR semantics preserved).
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
				if (a >= 0 && b >= a && b <= 59) return Array.from({ length: b - a + 1 }, (_, i) => i + a);
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
		const allHours = Array.from({ length: 24 }, (_, i) => i);
		const allMins = Array.from({ length: 60 }, (_, i) => i);
		const anchor = zonedDayParts(from, tz);
		// Up to 4 years of days: Feb-29-only crons legitimately skip three.
		for (let i = 0; i < 1461; i++) {
			const day = calendarDay(anchor, i);
			if (months && !months.includes(day.m)) continue;
			const dowMatch = !dows || dows.includes(day.dow);
			const domMatch = !doms || doms.includes(day.d);
			// Vixie semantics: when BOTH dom and dow are constrained they
			// AND; a wildcard on either side turns it into OR.
			const dayMatch = !doms || !dows ? domMatch || dowMatch : domMatch && dowMatch;
			if (!dayMatch) continue;
			for (const h of hours ?? allHours) {
				for (const m of mins ?? allMins) {
					const at = zonedTimeToEpoch(day.y, day.m, day.d, h, m, tz);
					if (at > from) return at;
				}
			}
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
 * and 00:00→end). No window → unchanged. Window times are wall-clock in
 * the schedule's timezone (host-local when undefined).
 */
export function constrainToIdleWindow(
	at: number,
	window: CronSchedule["idleWindow"] | undefined,
	from: number,
	tz?: string,
): number {
	if (!window) return at;
	const start = parseTime(window.start);
	const end = parseTime(window.end);
	if (!start || !end) return at;
	const atDay = zonedDayParts(at, tz);
	const startMs = zonedTimeToEpoch(atDay.y, atDay.m, atDay.d, start.h, start.m, tz);
	const endMs = zonedTimeToEpoch(atDay.y, atDay.m, atDay.d, end.h, end.m, tz);
	if (startMs <= endMs) {
		// Same-day window (09:00–18:00).
		if (at < startMs) return startMs;
		if (at <= endMs) return at;
		const nextDay = calendarDay(atDay, 1);
		return zonedTimeToEpoch(nextDay.y, nextDay.m, nextDay.d, start.h, start.m, tz);
	}
	// Crosses midnight (22:00–08:00).
	if (at >= startMs) return at; // 22:00–24:00 leg
	if (at <= endMs) return at; // 00:00–08:00 leg
	// In the daytime gap: the nearest window start measured from `from`
	// (today's opening if still ahead, else tomorrow's) — anchoring on
	// `at`'s date would skip a same-day opening that is closer.
	const fromDay = zonedDayParts(from, tz);
	const fromStartMs = zonedTimeToEpoch(fromDay.y, fromDay.m, fromDay.d, start.h, start.m, tz);
	if (fromStartMs > from) return fromStartMs;
	const nextDay = calendarDay(fromDay, 1);
	return zonedTimeToEpoch(nextDay.y, nextDay.m, nextDay.d, start.h, start.m, tz);
}

/** Next `count` fire times after `from` (epoch ms, ascending) — backs the
 *  cron.nextRuns RPC so clients preview the daemon's own parser (timezone
 *  + idle-window semantics included) instead of forking it. */
export function nextCronScheduleRuns(schedule: CronSchedule, from: number, count: number): number[] {
	const out: number[] = [];
	let cursor = from;
	const probe = { schedule };
	for (let i = 0; i < 2000 && out.length < count; i++) {
		const next = computeNextRun(probe, cursor);
		if (next === null) break;
		out.push(next);
		cursor = next + 1;
	}
	return out;
}
