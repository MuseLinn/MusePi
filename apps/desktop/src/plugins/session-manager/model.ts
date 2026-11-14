import type { SessionLifecycle, SessionListRow } from "./types";

/**
 * Pure view-model for the 会话管理 page: session.list rows + the local archive
 * store become one sortable/filterable/paginated row set. Kept out of the
 * component so the selection rules (status precedence, project identity,
 * null-last time ordering, page clamping) are unit-testable without a DOM.
 */

/** One archived session's archive time, keyed by session id. */
export type ArchivedTimes = ReadonlyMap<string, number>;

/** 进行中 / 已完成 / 已归档 — the archive store wins over live activity. */
type SessionStatus = "running" | "completed" | "archived";

/** Why a finished conversation stopped — the wire shape's own union, named
 *  for the view axis it drives (normal completion, cut-off turn, user abort,
 *  error, or a read still in flight). */
export type SessionOutcome = SessionLifecycle;

export type StatusFilter = "all" | SessionStatus;

export type SessionSortKey = "title" | "project" | "status" | "updatedAt";

export interface SessionSort {
	key: SessionSortKey;
	dir: "asc" | "desc";
}

export interface SessionFilters {
	/** Full cwd path, {@link PROJECT_ALL} or {@link PROJECT_NONE}. */
	project: string;
	status: StatusFilter;
	/** Activity window in days; 0 = any time. */
	days: number;
	query: string;
}

export interface SessionView {
	id: string;
	/** Stored/auto title, else an id prefix (the session list's own fallback). */
	title: string;
	cwd: string | null;
	/** Basename label from projectLabels (widened only when ambiguous). */
	project: string;
	status: SessionStatus;
	/** Why the session stopped; null while running or archived (archive time
	 *  replaces it in the status column). */
	outcome: SessionOutcome | null;
	/** Last activity, ISO (falls back to the creation timestamp). */
	updatedAt: string | null;
	/** Completion/archive time; null while the session is still running. */
	completedAt: string | null;
	archivedAt: number | null;
	messageCount: number;
}

/** "All projects" sentinel — a cwd can never be an asterisk. */
export const PROJECT_ALL = "*";
/** Sessions with no cwd: one bucket, distinct from "all". */
export const PROJECT_NONE = "";

export const PAGE_SIZE = 20;

const DAY_MS = 86_400_000;

function parsed(value: string | undefined | null): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function titleOf(row: SessionListRow): string {
	const title = typeof row.title === "string" ? row.title.trim() : "";
	return title.length > 0 ? title : row.id.slice(0, 10);
}

/** Build the page's row set: auxiliary sessions (subagents/advisors) are
 *  navigation details of their parent, not managed conversations. */
export function buildSessionViews(
	rows: readonly SessionListRow[],
	archived: ArchivedTimes,
	labels: ReadonlyMap<string, string>,
): SessionView[] {
	const views: SessionView[] = [];
	for (const row of rows) {
		if (row.subagent === true || row.advisor === true) continue;
		const updatedMs = parsed(row.updatedAt) ?? parsed(row.timestamp);
		const updatedAt = updatedMs === null ? null : iso(updatedMs);
		const archivedAt = archived.get(row.id) ?? null;
		const status: SessionStatus = archivedAt !== null ? "archived" : row.working === true ? "running" : "completed";
		// Archived rows show when they were archived; a completed row's last
		// activity IS its completion time, and a running row has none yet.
		const completedAt =
			status === "archived"
				? archivedAt !== null && archivedAt > 0
					? iso(archivedAt)
					: updatedAt
				: status === "completed"
					? updatedAt
					: null;
		const cwd = typeof row.cwd === "string" && row.cwd.length > 0 ? row.cwd : null;
		views.push({
			id: row.id,
			title: titleOf(row),
			cwd,
			project: cwd === null ? "" : (labels.get(cwd) ?? cwd),
			status,
			outcome: status === "completed" ? (row.status ?? null) : null,
			updatedAt,
			completedAt,
			archivedAt,
			messageCount: typeof row.messageCount === "number" ? row.messageCount : 0,
		});
	}
	return views;
}

/** Distinct projects in display order — the filter's option source. */
export function projectOptions(views: readonly SessionView[]): Array<{ value: string; label: string; count: number }> {
	const byCwd = new Map<string, { label: string; count: number }>();
	let none = 0;
	for (const view of views) {
		if (view.cwd === null) {
			none += 1;
			continue;
		}
		const entry = byCwd.get(view.cwd);
		if (entry) entry.count += 1;
		else byCwd.set(view.cwd, { label: view.project, count: 1 });
	}
	const options = [...byCwd.entries()]
		.map(([value, entry]) => ({ value, label: entry.label, count: entry.count }))
		.sort((a, b) => compareText(a.label, b.label) || compareText(a.value, b.value));
	if (none > 0) options.push({ value: PROJECT_NONE, label: "", count: none });
	return options;
}

/** Title / project / path / id match for the table's search box. Message-body
 *  matches come from `session.search` and are unioned by the page. */
export function matchesSessionText(view: SessionView, rawQuery: string): boolean {
	const query = rawQuery.trim().toLowerCase();
	if (query.length === 0) return true;
	return (
		view.title.toLowerCase().includes(query) ||
		view.project.toLowerCase().includes(query) ||
		(view.cwd?.toLowerCase().includes(query) ?? false) ||
		view.id.toLowerCase().includes(query)
	);
}

export function filterViews(views: readonly SessionView[], filters: SessionFilters, now: number): SessionView[] {
	const cutoff = filters.days > 0 ? now - filters.days * DAY_MS : null;
	return views.filter(view => {
		if (filters.project !== PROJECT_ALL && (view.cwd ?? PROJECT_NONE) !== filters.project) return false;
		if (filters.status !== "all" && view.status !== filters.status) return false;
		if (cutoff !== null) {
			const last = parsed(view.updatedAt);
			if (last === null || last < cutoff) return false;
		}
		return matchesSessionText(view, filters.query);
	});
}

const STATUS_RANK: Record<SessionStatus, number> = { running: 0, completed: 1, archived: 2 };

function compareText(a: string, b: string): number {
	const left = a.toLowerCase();
	const right = b.toLowerCase();
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Null/absent times always sink to the bottom; direction only applies to
 *  real values so "oldest first" never puts unknown dates on top. */
function compareTime(a: string | null, b: string | null, dir: "asc" | "desc"): number {
	const left = parsed(a);
	const right = parsed(b);
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	return dir === "asc" ? left - right : right - left;
}

export function sortViews(views: readonly SessionView[], sort: SessionSort): SessionView[] {
	const sorted = [...views];
	sorted.sort((a, b) => {
		let result = 0;
		switch (sort.key) {
			case "title":
				result = compareText(a.title, b.title);
				break;
			case "project":
				result = compareText(a.project, b.project);
				break;
			case "status":
				result = STATUS_RANK[a.status] - STATUS_RANK[b.status];
				break;
			case "updatedAt":
				result = compareTime(a.updatedAt, b.updatedAt, sort.dir);
				break;
		}
		if (sort.dir === "desc" && sort.key !== "updatedAt") result = -result;
		return result || compareText(a.id, b.id);
	});
	return sorted;
}

export function pageTotal(total: number, size = PAGE_SIZE): number {
	return Math.max(1, Math.ceil(total / size));
}

export function clampPage(page: number, total: number, size = PAGE_SIZE): number {
	return Math.min(Math.max(1, page), pageTotal(total, size));
}

export function pageSlice<T>(items: readonly T[], page: number, size = PAGE_SIZE): T[] {
	const start = (page - 1) * size;
	return items.slice(start, start + size);
}

/** Toggle one header/row checkbox target over a page of ids. */
export function toggleAll(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
	const next = new Set(selected);
	const allSelected = ids.length > 0 && ids.every(id => next.has(id));
	for (const id of ids) {
		if (allSelected) next.delete(id);
		else next.add(id);
	}
	return next;
}

/** MM-DD HH:mm (the year appears only for a different year) — dense enough
 *  for a table cell, unambiguous enough to scan. */
export function formatSessionTime(value: string | null, now = new Date()): string {
	const ms = parsed(value);
	if (ms === null) return "—";
	const date = new Date(ms);
	const sameYear = date.getFullYear() === now.getFullYear();
	return date.toLocaleString(undefined, {
		...(sameYear ? {} : { year: "numeric" }),
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}
