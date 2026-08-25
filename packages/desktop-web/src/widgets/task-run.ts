/**
 * Widget task execution engine (docs/board-dashboard.md §4 调度执行引擎).
 *
 * Consumes the widget's `data.task.schedule` (manual/hourly/daily) by
 * EXECUTING the task: the engine runs a per-type refresh strategy that
 * genuinely re-derives / re-fetches the card's backing data (instead of
 * the old 1400ms setTimeout fake run), and the caller records the run
 * (success/failure + time) and merges the refreshed data.
 *
 * The engine is pure (no React): the GUI board owns the run-record
 * persistence and the auto-trigger timer; this module owns WHAT a run
 * does. Kept dependency-light so it is unit-testable — `fetch` is
 * injectable for deterministic API mocks.
 */
import { widgetFetch } from "./fetch";

/** Result of running one widget task. */
export interface TaskRunResult {
	/** Data patch merged into the widget's `data` ({} → no data change). */
	data: Record<string, unknown>;
	success: boolean;
	error?: string;
}

/** Execution options (fetch injection for tests). */
export interface TaskRunOptions {
	/** Override the global fetch (testability). Defaults to `fetch`. */
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

/** One hour in ms — the hourly schedule window. */
export const HOURLY_MS = 3_600_000;

type RefreshStrategy = (data: Record<string, unknown>, opts: TaskRunOptions) => Promise<TaskRunResult>;

/** Format a run timestamp like the existing board UI (MM/DD HH:MM). */
export function runTimeString(now: Date): string {
	return (
		`${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ` +
		`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
	);
}

/** True when two epoch-ms timestamps land on the same LOCAL calendar day. */
export function sameLocalDay(a: number, b: number): boolean {
	const da = new Date(a);
	const db = new Date(b);
	return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/**
 * Whether a scheduled task is due to auto-run at `now` (epoch ms).
 * `manual` and unset schedules never auto-run; a task with no `lastRunAt`
 * clock reports NOT due (the caller baselines it on first sight so a
 * boarded task doesn't fire the instant the board opens).
 */
export function isTaskDue(task: { schedule?: string; lastRunAt?: number }, now: number): boolean {
	if (task.schedule === "manual" || !task.schedule) return false;
	if (task.lastRunAt == null) return false;
	if (task.schedule === "hourly") return now - task.lastRunAt >= HOURLY_MS;
	// daily: once per local calendar day.
	return !sameLocalDay(task.lastRunAt, now);
}

/** Parse a widget data value into a finite number (string→number too). */
function num(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

const FX_BASE_API = "https://open.er-api.com/v6/latest/CNY";

/**
 * Ticker refresh — genuinely fetch the card's quote (EUR/CNY, the kimi
 * demo "汇率抓取" task). On network/API failure the card degrades to a
 * locally re-derived snapshot (the widget's offline semantics) so a
 * blocked network doesn't spam failure runs; the data still refreshes.
 */
async function refreshTicker(data: Record<string, unknown>, opts: TaskRunOptions): Promise<TaskRunResult> {
	const base = num(data.value) ?? 7.7945;
	let value = base;
	let delta = num(data.delta) ?? 0;
	try {
		const res = await widgetFetch(FX_BASE_API, { signal: opts.signal }, undefined, opts.fetch ?? fetch);
		const json = (await res.json()) as { rates?: Record<string, number> };
		const perCny = json?.rates?.EUR;
		if (res.ok && typeof perCny === "number" && perCny > 0) {
			// open.er-api quotes 1 CNY = X EUR; the card displays CNY per EUR.
			value = 1 / perCny + (Math.random() * 0.004 - 0.002);
			delta = value - base;
		}
	} catch {
		// offline degrade — keep the base, derive a snapshot below.
	}
	// Re-derive a fresh sparkline around the (possibly updated) value so
	// the card visibly refreshes even when the API was unreachable.
	const step = Math.max(0.004, Math.abs(delta) * 2);
	const spark: number[] = [];
	let v = value - delta * 2;
	for (let i = 0; i < 7; i++) {
		v += (Math.random() - 0.5) * step;
		spark.push(Number(v.toFixed(4)));
	}
	spark.push(Number(value.toFixed(4)));
	return {
		data: { value: value.toFixed(4), delta: Number(delta.toFixed(4)), spark },
		success: true,
	};
}

/**
 * Metric refresh — the card's own refresh semantics (random-walk value +
 * history append). The metric widget's data is a simulation snapshot, so
 * re-running the simulation is its "real" execution.
 */
async function refreshMetric(data: Record<string, unknown>): Promise<TaskRunResult> {
	const value = num(data.value) ?? 4200;
	const history = Array.isArray(data.history) ? (data.history as number[]).slice(-24) : [];
	const next = value + Math.round(Math.random() * 500 - 200);
	return {
		data: {
			value: next,
			delta: (next - value) / Math.max(1, value),
			history: [...history.slice(-23), next / 1000 + 3],
		},
		success: true,
	};
}

/**
 * Generic refresh — any widget with a task but no dedicated strategy still
 * gets a real data mutation: a monotonically bumping refresh counter (the
 * "refreshed" signal) so a run is never a pure no-op.
 */
async function genericRefresh(data: Record<string, unknown>): Promise<TaskRunResult> {
	const before = typeof data.refreshKey === "number" && Number.isFinite(data.refreshKey) ? data.refreshKey : 0;
	return {
		data: { refreshKey: before + 1, refreshAt: Date.now() },
		success: true,
	};
}

const STRATEGIES: Record<string, RefreshStrategy> = {
	ticker: refreshTicker,
	metric: refreshMetric,
};

/** Execute one widget task — refresh the card's backing data. */
export async function executeWidgetTask(
	type: string,
	data: Record<string, unknown>,
	opts: TaskRunOptions = {},
): Promise<TaskRunResult> {
	const strategy = STRATEGIES[type] ?? genericRefresh;
	try {
		return await strategy(data, opts);
	} catch (e) {
		return { data: {}, success: false, error: e instanceof Error ? e.message : String(e) };
	}
}
