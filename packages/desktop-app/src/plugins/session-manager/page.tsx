import type { TranslationKey } from "@musepi/client-core";
import { Segmented, t, useArchivedSessions } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hitText } from "../../components/settings-sections/shared";
import { projectLabels } from "../../lib/project-label";
import { useConfirm } from "../../lib/prompt-dialog";
import {
	CLEANUP_ACTION_KEY,
	CLEANUP_DAYS_KEY,
	CLEANUP_KEY,
	cleanupCandidates,
	cleanupAction as readCleanupAction,
	cleanupDays as readCleanupDays,
	cleanupEnabled as readCleanupEnabled,
	runCleanupOnce,
} from "../../lib/session-cleanup";
import type { SlotComponentProps } from "../../lib/slot-host";
import { Icon } from "../../vendor/oc-icons";
import {
	buildSessionViews,
	clampPage,
	filterViews,
	formatSessionTime,
	lastUserPrompt,
	PROJECT_ALL,
	PROJECT_NONE,
	pageSlice,
	pageTotal,
	projectOptions,
	type SessionFilters,
	type SessionSort,
	type SessionSortKey,
	type SessionStatus,
	type SessionView,
	type StatusFilter,
	sortViews,
	toggleAll,
} from "./model";
import type { SessionListRow, SessionSearchResult } from "./types";

/**
 * Settings → 会话 (Cordis `settings.tab.sessions`): the session-management
 * page. Data comes from the existing daemon surface only —
 * `session.list` for rows, `session.search` for each visible row's newest
 * user prompt, `session.delete` for permanent removal — plus the shared
 * local archive store (archiving is a local list edit, exactly like the
 * sidebar). The retention settings below the table keep using
 * lib/session-cleanup so the app-shell's hourly cleanup and this page agree
 * on the same preferences.
 */

const STATUS_LABEL: Record<SessionStatus, TranslationKey> = {
	running: "settings.inProgress",
	completed: "settings.sessionManager.statusCompleted",
	archived: "settings.archived",
};

const STATUS_DOT: Record<SessionStatus, string> = {
	running: "bg-[var(--color-accent)]",
	completed: "bg-[var(--color-success)]",
	archived: "bg-[var(--color-text-faint)]",
};

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: TranslationKey }> = [
	{ value: "all", label: "settings.sessionManager.allStatuses" },
	{ value: "running", label: "settings.inProgress" },
	{ value: "completed", label: "settings.sessionManager.statusCompleted" },
	{ value: "archived", label: "settings.archived" },
];

const DAY_OPTIONS: Array<{ value: number; label: TranslationKey }> = [
	{ value: 0, label: "settings.sessionManager.anyTime" },
	{ value: 1, label: "settings.sessionManager.last24Hours" },
	{ value: 7, label: "settings.sessionManager.last7Days" },
	{ value: 30, label: "settings.sessionManager.last30Days" },
	{ value: 90, label: "settings.sessionManager.last90Days" },
];

const DEFAULT_SORT: SessionSort = { key: "updatedAt", dir: "desc" };

const DEFAULT_DRAFT = { project: PROJECT_ALL, status: "all" as StatusFilter, days: 0 };

/** Prompt reads per page are bounded: three in flight, newest-first 50-row
 *  pages, one request per session per mount. */
const PROMPT_CONCURRENCY = 3;
const PROMPT_SCAN_LIMIT = 50;

const MIN_DAYS = 1;
const MAX_DAYS = 365;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function SessionManagerPage({ rpc, sessionId, onOpenSession }: SlotComponentProps): ReactNode {
	const [rows, setRows] = useState<SessionListRow[] | null>(null);
	const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
	const [loadError, setLoadError] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	const { archived, ids: archivedIds, archive, unarchive } = useArchivedSessions();
	const { confirm } = useConfirm();
	const archivedSignature = archived.map(entry => `${entry.sessionId}:${entry.archivedAt}`).join("\n");
	const archivedTimes = useMemo(() => {
		const map = new Map<string, number>();
		for (const entry of archived) map.set(entry.sessionId, entry.archivedAt);
		return map;
	}, [archivedSignature]);

	useEffect(() => {
		if (!rpc) {
			setRows([]);
			setLoadState("ready");
			return;
		}
		let alive = true;
		setLoadState("loading");
		setLoadError(null);
		void rpc
			.request<SessionListRow[]>("session.list", {})
			.then(list => {
				if (!alive) return;
				setRows(Array.isArray(list) ? list : []);
				setLoadState("ready");
			})
			.catch(error => {
				if (!alive) return;
				setRows(null);
				setLoadError(errorText(error));
				setLoadState("error");
			});
		return () => {
			alive = false;
		};
	}, [rpc, reloadToken]);

	const views = useMemo(() => {
		const list = rows ?? [];
		const paths = list.map(row => row.cwd).filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
		return buildSessionViews(list, archivedTimes, projectLabels(paths));
	}, [rows, archivedTimes]);

	const projects = useMemo(() => projectOptions(views), [views]);

	const [draft, setDraft] = useState(DEFAULT_DRAFT);
	const [filters, setFilters] = useState<SessionFilters>({ ...DEFAULT_DRAFT, query: "" });
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SessionSort>(DEFAULT_SORT);
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [opError, setOpError] = useState<string | null>(null);

	const filtered = useMemo(() => filterViews(views, { ...filters, query }, Date.now()), [views, filters, query]);
	const sorted = useMemo(() => sortViews(filtered, sort), [filtered, sort]);
	const pages = pageTotal(sorted.length);
	const currentPage = clampPage(page, sorted.length);
	const visible = pageSlice(sorted, currentPage);
	const visibleKey = visible.map(view => view.id).join(",");

	// Selection never outlives the filters that produced it: a row hidden by a
	// new filter must not stay queued for a bulk action.
	useEffect(() => {
		const allowed = new Set(filtered.map(view => view.id));
		setSelected(previous => {
			if (previous.size === 0) return previous;
			let changed = false;
			const next = new Set<string>();
			for (const id of previous) {
				if (allowed.has(id)) next.add(id);
				else changed = true;
			}
			return changed ? next : previous;
		});
	}, [filtered]);

	const selectedViews = useMemo(() => views.filter(view => selected.has(view.id)), [views, selected]);
	const selectedCount = selectedViews.length;
	const selectionHasCurrent = sessionId != null && selected.has(sessionId);
	const canDelete = (view: SessionView): boolean => sessionId == null || view.id !== sessionId;

	const applyFilters = (): void => {
		setFilters({ project: draft.project, status: draft.status, days: draft.days, query });
		setPage(1);
	};

	const resetFilters = (): void => {
		setDraft(DEFAULT_DRAFT);
		setFilters({ ...DEFAULT_DRAFT, query: "" });
		setQuery("");
		setPage(1);
		setSelected(new Set());
	};

	const changeSort = (key: SessionSortKey): void => {
		setSort(previous =>
			previous.key === key
				? { key, dir: previous.dir === "asc" ? "desc" : "asc" }
				: { key, dir: key === "updatedAt" || key === "completedAt" ? "desc" : "asc" },
		);
		setPage(1);
	};

	// ── last prompt (visible rows only) ─────────────────────────────────
	const promptsRef = useRef(new Map<string, string | null>());
	const [, setPromptVersion] = useState(0);
	useEffect(() => {
		if (!rpc) return;
		const pending = visible.filter(view => !promptsRef.current.has(view.id));
		if (pending.length === 0) return;
		let alive = true;
		const queue = [...pending];
		const loadNext = async (): Promise<void> => {
			while (alive) {
				const next = queue.shift();
				if (!next) return;
				let text: string | null = null;
				try {
					// Newest-first page; the last user message in it is the session's
					// latest prompt without reading the whole transcript.
					const result = await rpc.request<SessionSearchResult>("session.search", {
						query: "",
						sessionId: next.id,
						limit: PROMPT_SCAN_LIMIT,
					});
					text = lastUserPrompt(result?.matches ?? [], hitText);
				} catch {
					text = null;
				}
				promptsRef.current.set(next.id, text);
				if (!alive) return;
				setPromptVersion(version => version + 1);
			}
		};
		void Promise.all(Array.from({ length: PROMPT_CONCURRENCY }, loadNext));
		return () => {
			alive = false;
		};
	}, [rpc, visibleKey]);

	// ── mutations ────────────────────────────────────────────────────────
	const deleteViews = useCallback(
		async (targets: SessionView[]): Promise<void> => {
			if (!rpc || targets.length === 0) return;
			setBusy(true);
			setOpError(null);
			const removed = new Set<string>();
			const failures: string[] = [];
			for (const view of targets) {
				try {
					await rpc.request("session.delete", { sessionId: view.id });
					removed.add(view.id);
					if (archivedIds.has(view.id)) unarchive(view.id);
				} catch (error) {
					failures.push(errorText(error));
				}
			}
			if (removed.size > 0) {
				setRows(previous => (previous ? previous.filter(row => !removed.has(row.id)) : previous));
				setSelected(previous => {
					const next = new Set(previous);
					for (const id of removed) next.delete(id);
					return next;
				});
			}
			if (failures.length > 0) {
				const summary = t("settings.sessionManager.partialFailure", { count: failures.length });
				setOpError(`${summary} ${failures[0] ?? ""}`.trim());
			}
			setBusy(false);
		},
		[rpc, archivedIds, unarchive],
	);

	const archiveOne = (view: SessionView): void => {
		archive(view.id, view.cwd ?? undefined);
	};

	const deleteOne = useCallback(
		async (view: SessionView): Promise<void> => {
			if (sessionId != null && view.id === sessionId) return;
			if (localStorage.getItem("musepi-gui-confirm-delete") !== "0") {
				const ok = await confirm(t("settings.sessionManager.confirmDelete", { count: 1 }), t("settings.delete"), {
					destructive: true,
				});
				if (!ok) return;
			}
			await deleteViews([view]);
		},
		[confirm, deleteViews, sessionId],
	);

	const bulkArchive = async (): Promise<void> => {
		const targets = selectedViews.filter(view => view.status !== "archived");
		if (targets.length === 0) return;
		const ok = await confirm(
			t("settings.sessionManager.confirmArchive", { count: targets.length }),
			t("settings.archive"),
		);
		if (!ok) return;
		for (const view of targets) archive(view.id, view.cwd ?? undefined);
		setSelected(new Set());
	};

	const bulkUnarchive = async (): Promise<void> => {
		const targets = selectedViews.filter(view => view.status === "archived");
		if (targets.length === 0) return;
		const ok = await confirm(
			t("settings.sessionManager.confirmUnarchive", { count: targets.length }),
			t("settings.unarchive"),
		);
		if (!ok) return;
		for (const view of targets) unarchive(view.id);
		setSelected(new Set());
	};

	const bulkDelete = async (): Promise<void> => {
		if (selectedCount === 0 || selectionHasCurrent) return;
		const ok = await confirm(
			t("settings.sessionManager.confirmDelete", { count: selectedCount }),
			t("settings.delete"),
			{ destructive: true },
		);
		if (!ok) return;
		await deleteViews(selectedViews);
	};

	// ── retention preferences (lib/session-cleanup owns the storage keys) ─
	const [cleanupOn, setCleanupOn] = useState<boolean>(readCleanupEnabled);
	const [cleanupDays, setCleanupDays] = useState<number>(readCleanupDays);
	const [cleanupAction, setCleanupAction] = useState<"archive" | "delete">(readCleanupAction);
	const [candidates, setCandidates] = useState<string[]>([]);
	const [runningCleanup, setRunningCleanup] = useState(false);
	const lastRunRef = useRef(0);
	const cleanedRef = useRef<Set<string>>(new Set());

	const computeCandidates = useCallback(async (): Promise<string[]> => {
		if (!rpc) return [];
		const list = await cleanupCandidates(rpc, cleanupDays, sessionId ?? null);
		return list.map(candidate => candidate.id).filter(id => !cleanedRef.current.has(id));
	}, [rpc, cleanupDays, sessionId]);

	useEffect(() => {
		void computeCandidates().then(setCandidates);
	}, [computeCandidates]);

	const runCleanup = useCallback(
		async (force = false): Promise<void> => {
			if (runningCleanup) return;
			if (!cleanupOn && !force) return;
			if (!force && Date.now() - lastRunRef.current < 86_400_000) return;
			setRunningCleanup(true);
			try {
				const ids = await computeCandidates();
				if (rpc && ids.length > 0) {
					await runCleanupOnce(rpc, ids, cleanupAction);
					for (const id of ids) cleanedRef.current.add(id);
				}
				lastRunRef.current = Date.now();
				setCandidates(await computeCandidates());
			} finally {
				setRunningCleanup(false);
			}
		},
		[runningCleanup, cleanupOn, rpc, cleanupAction, computeCandidates],
	);

	useEffect(() => {
		if (!cleanupOn) return;
		const timer = setInterval(() => void runCleanup(), 3_600_000);
		return () => clearInterval(timer);
	}, [cleanupOn, runCleanup]);

	const setDays = (next: number): void => {
		const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, next));
		setCleanupDays(clamped);
		localStorage.setItem(CLEANUP_DAYS_KEY, String(clamped));
	};

	const [autoTitle, setAutoTitle] = useState<boolean>(() => localStorage.getItem("musepi-gui-autotitle") !== "0");
	const [confirmDelete, setConfirmDelete] = useState<boolean>(
		() => localStorage.getItem("musepi-gui-confirm-delete") !== "0",
	);

	// ── render ───────────────────────────────────────────────────────────
	const header = (key: SessionSortKey, label: string): ReactNode => {
		const active = sort.key === key;
		const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
		return (
			<th scope="col" aria-sort={ariaSort} className="whitespace-nowrap px-2 py-2 font-medium">
				<button
					type="button"
					className={`inline-flex items-center gap-1 bg-transparent p-0 text-[11.5px] ${
						active ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"
					}`}
					onClick={() => changeSort(key)}
					title={t("settings.sessionManager.sortBy", { column: label })}
				>
					{label}
					<span aria-hidden className="text-[10px] opacity-70">
						{active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
					</span>
				</button>
			</th>
		);
	};

	const headerIds = visible.map(view => view.id);
	const allVisibleSelected = headerIds.length > 0 && headerIds.every(id => selected.has(id));
	const hasArchiveTargets = selectedViews.some(view => view.status !== "archived");
	const hasUnarchiveTargets = selectedViews.some(view => view.status === "archived");

	const renderBody = (): ReactNode => {
		if (loadState === "error") {
			return (
				<div className="flex flex-col gap-2 py-4" role="alert">
					<div className="gui-group-label">{t("settings.sessionManager.error")}</div>
					<p className="m-0 text-[12px] text-[var(--color-text-faint)]">{loadError}</p>
					<button
						type="button"
						className="gui-btn gui-btn--small self-start"
						onClick={() => setReloadToken(token => token + 1)}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
						{t("settings.sessionManager.retry")}
					</button>
				</div>
			);
		}
		if (loadState === "loading" && rows === null) {
			return (
				<div className="flex items-center gap-2 py-4 text-[12px] text-[var(--color-text-faint)]" role="status">
					<Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
					{t("settings.sessionManager.loading")}
				</div>
			);
		}
		if (sorted.length === 0) {
			return (
				<div className="py-6 text-center" role="status">
					<p className="m-0 text-[13px] font-medium">
						{views.length === 0 ? t("settings.sessionManager.empty") : t("settings.sessionManager.emptyFiltered")}
					</p>
					<p className="m-0 mt-1 text-[12px] text-[var(--color-text-faint)]">
						{t("settings.sessionManager.emptyHint")}
					</p>
				</div>
			);
		}
		return (
			<div className="overflow-x-auto">
				<table className="w-full min-w-[760px] border-collapse text-left text-[12px]">
					<thead className="sticky top-0 z-[1] border-b border-[var(--border)] bg-[var(--color-surface)]">
						<tr>
							<th scope="col" className="w-8 px-2 py-2">
								<input
									type="checkbox"
									checked={allVisibleSelected}
									onChange={() => setSelected(previous => toggleAll(previous, headerIds))}
									aria-label={t("settings.sessionManager.selectAll")}
								/>
							</th>
							{header("title", t("settings.sessionManager.sessionName"))}
							{header("project", t("settings.sessionManager.project"))}
							{header("status", t("settings.sessionManager.status"))}
							<th scope="col" className="px-2 py-2 font-medium">
								{t("settings.sessionManager.lastPrompt")}
							</th>
							{header("updatedAt", t("settings.sessionManager.lastUpdated"))}
							{header("completedAt", t("settings.sessionManager.completedAt"))}
							<th scope="col" className="whitespace-nowrap px-2 py-2 text-right font-medium">
								{t("settings.sessionManager.actions")}
							</th>
						</tr>
					</thead>
					<tbody>
						{visible.map(view => {
							const prompt = promptsRef.current.get(view.id);
							const promptText =
								prompt === undefined ? t("settings.sessionManager.promptLoading") : (prompt ?? "—");
							const current = !canDelete(view);
							return (
								<tr key={view.id} className="border-b border-[var(--border)] last:border-b-0">
									<td className="px-2 py-1.5 align-middle">
										<input
											type="checkbox"
											checked={selected.has(view.id)}
											onChange={() => setSelected(previous => toggleAll(previous, [view.id]))}
											aria-label={t("settings.sessionManager.selectRow", {
												title: view.title,
											})}
										/>
									</td>
									<td className="max-w-[180px] px-2 py-1.5 align-middle">
										<div className="flex items-center gap-1.5">
											<span className="truncate font-medium" title={view.title}>
												{view.title}
											</span>
											{current && (
												<span className="shrink-0 rounded-full bg-[var(--color-surface-raised)] px-1.5 text-[10px] text-[var(--color-text-faint)]">
													{t("settings.sessionManager.currentSession")}
												</span>
											)}
										</div>
										<div
											className="truncate font-mono text-[10px] text-[var(--color-text-faint)]"
											title={view.id}
										>
											{view.id}
										</div>
									</td>
									<td
										className="max-w-[120px] truncate px-2 py-1.5 align-middle text-[var(--color-text-muted)]"
										title={view.cwd ?? undefined}
									>
										{view.cwd === null ? t("settings.sessionManager.noProject") : view.project}
									</td>
									<td className="whitespace-nowrap px-2 py-1.5 align-middle">
										<span className="inline-flex items-center gap-1.5">
											<span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[view.status]}`} />
											{t(STATUS_LABEL[view.status])}
										</span>
									</td>
									<td
										className="max-w-[220px] truncate px-2 py-1.5 align-middle text-[var(--color-text-muted)]"
										title={prompt ?? undefined}
									>
										{promptText}
									</td>
									<td className="whitespace-nowrap px-2 py-1.5 align-middle tabular-nums">
										{formatSessionTime(view.updatedAt)}
									</td>
									<td className="whitespace-nowrap px-2 py-1.5 align-middle tabular-nums text-[var(--color-text-muted)]">
										{formatSessionTime(view.completedAt)}
									</td>
									<td className="whitespace-nowrap px-2 py-1.5 text-right align-middle">
										<div className="inline-flex items-center gap-0.5">
											{onOpenSession && (
												<button
													type="button"
													className="gui-pane-action w-auto px-1.5"
													disabled={busy || current}
													title={t("settings.open")}
													aria-label={t("settings.open")}
													onClick={() => onOpenSession(view.id)}
												>
													<Icon name="chat-history" className="h-3.5 w-3.5" />
												</button>
											)}
											{view.status === "archived" ? (
												<button
													type="button"
													className="gui-pane-action w-auto px-1.5"
													title={t("settings.unarchive")}
													aria-label={t("settings.unarchive")}
													onClick={() => unarchive(view.id)}
												>
													<Icon name="restart" className="h-3.5 w-3.5" />
												</button>
											) : (
												<button
													type="button"
													className="gui-pane-action w-auto px-1.5"
													title={t("settings.archive")}
													aria-label={t("settings.archive")}
													onClick={() => archiveOne(view)}
												>
													<Icon name="inbox-archive" className="h-3.5 w-3.5" />
												</button>
											)}
											<button
												type="button"
												className="gui-pane-action w-auto px-1.5"
												disabled={busy || current}
												title={
													current
														? t("settings.sessionManager.deleteCurrentBlocked")
														: t("settings.delete")
												}
												aria-label={t("settings.delete")}
												onClick={() => void deleteOne(view)}
											>
												<Icon name="delete-bin" className="h-3.5 w-3.5" />
											</button>
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		);
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.sessionManager.title")}</h2>
			<p className="gui-settings-page-desc">{t("settings.sessionManager.description")}</p>

			<form
				className="mt-4 flex flex-wrap items-center gap-2"
				onSubmit={event => {
					event.preventDefault();
					applyFilters();
				}}
			>
				<select
					className="gui-settings-select"
					style={{ minWidth: 140 }}
					value={draft.project}
					aria-label={t("settings.sessionManager.project")}
					onChange={event => setDraft(previous => ({ ...previous, project: event.target.value }))}
				>
					<option value={PROJECT_ALL}>{t("settings.sessionManager.allProjects")}</option>
					{projects.map(option => (
						<option key={option.value || PROJECT_NONE} value={option.value}>
							{option.value === PROJECT_NONE ? t("settings.sessionManager.noProject") : option.label}
						</option>
					))}
				</select>
				<select
					className="gui-settings-select"
					style={{ minWidth: 120 }}
					value={draft.status}
					aria-label={t("settings.sessionManager.status")}
					onChange={event => setDraft(previous => ({ ...previous, status: event.target.value as StatusFilter }))}
				>
					{STATUS_OPTIONS.map(option => (
						<option key={option.value} value={option.value}>
							{t(option.label)}
						</option>
					))}
				</select>
				<select
					className="gui-settings-select"
					style={{ minWidth: 120 }}
					value={draft.days}
					aria-label={t("settings.sessionManager.updatedWithin")}
					onChange={event => setDraft(previous => ({ ...previous, days: Number(event.target.value) }))}
				>
					{DAY_OPTIONS.map(option => (
						<option key={option.value} value={option.value}>
							{t(option.label)}
						</option>
					))}
				</select>
				<button type="submit" className="gui-btn gui-btn--small">
					{t("settings.sessionManager.query")}
				</button>
				<button type="button" className="gui-btn gui-btn--small" onClick={resetFilters}>
					{t("settings.sessionManager.reset")}
				</button>
				<label className="gui-settings-search flex-1" style={{ margin: 0, marginLeft: "auto", minWidth: 180 }}>
					<Icon name="search" className="h-3.5 w-3.5 flex-none" />
					<input
						className="gui-input min-w-0 flex-1"
						type="search"
						value={query}
						onChange={event => {
							setQuery(event.target.value);
							setPage(1);
						}}
						placeholder={t("settings.sessionManager.searchPlaceholder")}
						aria-label={t("settings.sessionManager.searchPlaceholder")}
					/>
				</label>
			</form>

			{selectedCount > 0 && (
				<div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-[12px]">
					<span className="tabular-nums">
						{t("settings.sessionManager.selectedCount", { count: selectedCount })}
					</span>
					<button
						type="button"
						className="gui-btn gui-btn--small"
						disabled={busy || !hasArchiveTargets}
						onClick={() => void bulkArchive()}
					>
						{t("settings.sessionManager.bulkArchive")}
					</button>
					<button
						type="button"
						className="gui-btn gui-btn--small"
						disabled={busy || !hasUnarchiveTargets}
						onClick={() => void bulkUnarchive()}
					>
						{t("settings.sessionManager.bulkUnarchive")}
					</button>
					<button
						type="button"
						className="gui-btn gui-btn--small"
						disabled={busy || selectionHasCurrent}
						title={selectionHasCurrent ? t("settings.sessionManager.deleteCurrentBlocked") : undefined}
						onClick={() => void bulkDelete()}
					>
						{t("settings.sessionManager.bulkDelete")}
					</button>
					<button type="button" className="gui-btn gui-btn--small" onClick={() => setSelected(new Set())}>
						{t("settings.sessionManager.clearSelection")}
					</button>
				</div>
			)}

			{opError && (
				<p className="m-0 mt-2 text-[12px] text-[var(--color-danger)]" role="alert">
					{opError}
				</p>
			)}

			<div className="mt-3">{renderBody()}</div>

			<div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--color-text-faint)]">
				<span className="tabular-nums">{t("settings.sessionManager.totalCount", { count: sorted.length })}</span>
				{pages > 1 && (
					<>
						<span className="ml-auto tabular-nums">
							{t("settings.sessionManager.pageInfo", { page: currentPage, pages })}
						</span>
						<button
							type="button"
							className="gui-btn gui-btn--small"
							disabled={currentPage <= 1}
							onClick={() => setPage(currentPage - 1)}
						>
							{t("settings.sessionManager.prevPage")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn--small"
							disabled={currentPage >= pages}
							onClick={() => setPage(currentPage + 1)}
						>
							{t("settings.sessionManager.nextPage")}
						</button>
					</>
				)}
			</div>

			{/* Session defaults + retention stay on this page: a replacement tab
			 *  must not make the built-in preferences unreachable. */}
			<div className="gui-settings-section mt-6">
				<div className="gui-settings-section-title">{t("general.sessionDefaults")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("general.autoTitle")}</div>
						<div className="gui-settings-row-desc">{t("general.autoTitleDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={autoTitle}
						className={`gui-toggle${autoTitle ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !autoTitle;
							setAutoTitle(next);
							localStorage.setItem("musepi-gui-autotitle", next ? "1" : "0");
						}}
						aria-label={t("general.autoTitle")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("general.showDeleteDialog")}</div>
						<div className="gui-settings-row-desc">{t("general.showDeleteDialogDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={confirmDelete}
						className={`gui-toggle${confirmDelete ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !confirmDelete;
							setConfirmDelete(next);
							localStorage.setItem("musepi-gui-confirm-delete", next ? "1" : "0");
						}}
						aria-label={t("general.showDeleteDialog")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			</div>

			<div className="gui-settings-section mt-4">
				<div className="gui-settings-section-title">{t("general.sessionRetention")}</div>
				<div className="gui-settings-section-desc">{t("general.sessionRetentionDescription")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("general.enableAutoCleanup")}</div>
						<div className="gui-settings-row-desc">{t("general.enableAutoCleanupDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={cleanupOn}
						className={`gui-toggle${cleanupOn ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !cleanupOn;
							setCleanupOn(next);
							localStorage.setItem(CLEANUP_KEY, next ? "1" : "0");
						}}
						aria-label={t("general.enableAutoCleanup")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className={`gui-settings-row${cleanupOn ? "" : " gui-settings-row--disabled"}`}>
					<div>
						<div className="gui-settings-row-label">{t("general.retentionDays")}</div>
						<div className="gui-settings-row-desc">{t("general.retentionDaysDescription")}</div>
					</div>
					<div className="gui-settings-control">
						<div className="gui-settings-stepper" aria-disabled={!cleanupOn}>
							<button
								type="button"
								className="gui-stepper-btn"
								disabled={!cleanupOn}
								aria-label={t("general.decrease")}
								onClick={() => setDays(cleanupDays - 1)}
							>
								<Icon name="subtract" className="h-3.5 w-3.5" />
							</button>
							<span className="gui-stepper-value">{cleanupDays}</span>
							<button
								type="button"
								className="gui-stepper-btn"
								disabled={!cleanupOn}
								aria-label={t("general.increase")}
								onClick={() => setDays(cleanupDays + 1)}
							>
								<Icon name="add" className="h-3.5 w-3.5" />
							</button>
							<span className="gui-settings-stepper-unit">{t("general.days")}</span>
						</div>
					</div>
				</div>
				<div className={`gui-settings-row${cleanupOn ? "" : " gui-settings-row--disabled"}`}>
					<div>
						<div className="gui-settings-row-label">{t("general.sessionExpiryAction")}</div>
						<div className="gui-settings-row-desc">{t("general.sessionExpiryActionDescription")}</div>
					</div>
					<Segmented
						ariaLabel={t("general.sessionExpiryAction")}
						value={cleanupAction}
						options={[
							{ value: "archive", label: t("settings.archive") },
							{ value: "delete", label: t("settings.delete") },
						]}
						onChange={value => {
							setCleanupAction(value);
							localStorage.setItem(CLEANUP_ACTION_KEY, value);
						}}
					/>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("general.manualCleanup")}</div>
						<div className="gui-settings-row-desc">
							{runningCleanup
								? t("general.cleanupRunning")
								: t("general.archivableCount", { count: String(candidates.length) })}
						</div>
					</div>
					<button
						type="button"
						className="gui-btn"
						disabled={runningCleanup || candidates.length === 0}
						onClick={() => void runCleanup(true)}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
						{t("general.runCleanupNow")}
					</button>
				</div>
			</div>
		</>
	);
}
