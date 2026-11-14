import type { TranslationKey } from "@musepi/client-core";
import { SESSION_OUTCOME_LABEL_KEYS, Segmented, t, useArchivedSessions } from "@musepi/client-core";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	matchesSessionText,
	PROJECT_ALL,
	PROJECT_NONE,
	pageSlice,
	pageTotal,
	projectOptions,
	type SessionFilters,
	type SessionOutcome,
	type SessionSort,
	type SessionSortKey,
	type SessionView,
	type StatusFilter,
	sortViews,
	toggleAll,
} from "./model";
import type { SessionLastPrompts, SessionListRow, SessionMessage, SessionSearchResult } from "./types";

/**
 * Settings → 会话 (Cordis `settings.tab.sessions`): the session-management
 * page, and the one place sessions are read. Data comes from the existing
 * daemon surface — `session.list` for rows, `session.lastPrompts` for one
 * page of prompt previews, `session.search` for cross-session message
 * matches, `history.messages` for the expanded row's transcript,
 * `session.delete` for permanent removal — plus the shared local archive
 * store (archiving is a local list edit, exactly like the sidebar). The
 * retention settings below the table keep using lib/session-cleanup so the
 * app-shell's hourly cleanup and this page agree on the same preferences.
 */

const STATUS_LABEL: Record<SessionOutcome, TranslationKey> = SESSION_OUTCOME_LABEL_KEYS;

const STATUS_DOT: Record<SessionOutcome, string> = {
	complete: "bg-[var(--color-success)]",
	interrupted: "bg-[var(--color-warning,var(--color-accent))]",
	aborted: "bg-[var(--color-text-faint)]",
	error: "bg-[var(--color-danger)]",
	pending: "bg-[var(--color-accent)]",
	unknown: "bg-[var(--color-text-faint)]",
};

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: TranslationKey }> = [
	{ value: "all", label: "settings.sessionManager.allStatuses" },
	{ value: "running", label: "settings.inProgress" },
	{ value: "completed", label: "settings.sessionManager.statusFinished" },
	{ value: "archived", label: "settings.archived" },
];

const DAY_OPTIONS: Array<{ value: number; label: TranslationKey }> = [
	{ value: 0, label: "settings.sessionManager.anyTime" },
	{ value: 1, label: "settings.sessionManager.last24Hours" },
	{ value: 7, label: "settings.sessionManager.last7Days" },
	{ value: 30, label: "settings.sessionManager.last30Days" },
	{ value: 90, label: "settings.sessionManager.last90Days" },
];

const DETAIL_SCOPE_OPTIONS: Array<{ value: "matches" | "all"; label: TranslationKey }> = [
	{ value: "matches", label: "settings.sessionManager.onlyMatches" },
	{ value: "all", label: "settings.sessionManager.allMessages" },
];

const DEFAULT_SORT: SessionSort = { key: "updatedAt", dir: "desc" };
const DEFAULT_FILTERS: SessionFilters = { project: PROJECT_ALL, status: "all", days: 0, query: "" };

/** Cross-session message search needs a real term; one character matches
 *  nearly everything and would stall the daemon's LIKE scan. */
const MIN_SEARCH_CHARS = 2;
const SEARCH_LIMIT = 200;
/** Expanded transcripts render the most recent rows only — a 500-row
 *  conversation is a wall of text, not a preview. */
const TRANSCRIPT_LIMIT = 200;
const CLAMP_CHARS = 1200;

const MIN_DAYS = 1;
const MAX_DAYS = 365;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Message bodies are flattened text already; collapse whitespace for the
 *  prompt column and fall back to null for tool-only turns. */
function promptText(raw: string | undefined): string | null {
	if (raw === undefined) return null;
	const text = hitText(raw).replace(/\s+/g, " ").trim();
	return text.length > 0 ? text : null;
}

function bySeq(a: SessionMessage, b: SessionMessage): number {
	return a.seq - b.seq;
}

/** Wrap the search term so a match inside a long message is visible at a
 *  glance instead of buried below the fold. */
function highlight(text: string, query: string): ReactNode {
	const term = query.trim();
	if (term.length === 0) return text;
	const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
	const nodes: ReactNode[] = [];
	let cursor = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > cursor) nodes.push(text.slice(cursor, index));
		nodes.push(<mark key={`${index}:${match[0]}`}>{match[0]}</mark>);
		cursor = index + match[0].length;
	}
	if (cursor < text.length) nodes.push(text.slice(cursor));
	return nodes;
}

interface MessageRowProps {
	message: SessionMessage;
	query: string;
	expanded: boolean;
	onToggleExpanded(): void;
}

function MessageRow({ message, query, expanded, onToggleExpanded }: MessageRowProps): ReactNode {
	const text = hitText(message.content).trim();
	const long = text.length > CLAMP_CHARS;
	const shown = long && !expanded ? `${text.slice(0, CLAMP_CHARS)}…` : text;
	return (
		<div className="gui-session-msg">
			<div className="gui-session-msg-head">
				<span className={`gui-session-role gui-session-role--${message.role}`}>{message.role}</span>
				<span>{new Date(message.timestamp).toLocaleString()}</span>
				{message.model && <span className="truncate font-mono">{message.model}</span>}
			</div>
			<div className="gui-session-msg-body">{highlight(shown, query)}</div>
			{long && (
				<button type="button" className="gui-session-msg-more" onClick={onToggleExpanded}>
					{expanded ? t("settings.sessionManager.collapseMessage") : t("settings.sessionManager.expandMessage")}
				</button>
			)}
		</div>
	);
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

	const [filters, setFilters] = useState<SessionFilters>(DEFAULT_FILTERS);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SessionSort>(DEFAULT_SORT);
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [opError, setOpError] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [detailScope, setDetailScope] = useState<"matches" | "all">("matches");
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

	// ── cross-session message search ────────────────────────────────────
	const [searchState, setSearchState] = useState<{ query: string; result: SessionSearchResult } | null>(null);
	const [searching, setSearching] = useState(false);

	useEffect(() => {
		const term = query.trim();
		if (term.length < MIN_SEARCH_CHARS) {
			setSearchState(null);
			setSearching(false);
			return;
		}
		setSearching(true);
		const timer = setTimeout(() => {
			if (!rpc) {
				setSearching(false);
				return;
			}
			void rpc
				.request<SessionSearchResult>("session.search", { query: term, limit: SEARCH_LIMIT })
				.then(result => setSearchState({ query: term, result: result ?? { matches: [], sessions: [] } }))
				.catch(() => setSearchState(null))
				.finally(() => setSearching(false));
		}, 300);
		return () => clearTimeout(timer);
	}, [query, rpc]);

	// Hits for the CURRENT term only — a stale response must not keep rows
	// that the new term no longer matches.
	const hitsBySession = useMemo(() => {
		const term = query.trim();
		const map = new Map<string, SessionMessage[]>();
		if (!searchState || searchState.query !== term) return map;
		for (const match of searchState.result.matches) {
			const list = map.get(match.sessionId) ?? [];
			list.push(match);
			map.set(match.sessionId, list);
		}
		return map;
	}, [searchState, query]);

	const term = query.trim();

	/** Project/status/time filters always apply; the text term matches either
	 *  the row's own text or any message inside the session. */
	const filtered = useMemo(() => {
		const now = Date.now();
		const base = filterViews(views, { ...filters, query: "" }, now);
		if (term.length === 0) return base;
		return base.filter(view => matchesSessionText(view, term) || hitsBySession.has(view.id));
	}, [views, filters, term, hitsBySession]);

	const sorted = useMemo(() => sortViews(filtered, sort), [filtered, sort]);
	const pages = pageTotal(sorted.length);
	const currentPage = clampPage(page, sorted.length);
	const visible = pageSlice(sorted, currentPage);
	const visibleIds = visible.map(view => view.id);
	const visibleKey = visibleIds.join(",");

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
	const filtersActive =
		filters.project !== PROJECT_ALL || filters.status !== "all" || filters.days !== 0 || term.length > 0;

	const resetFilters = (): void => {
		setFilters(DEFAULT_FILTERS);
		setQuery("");
		setPage(1);
		setSelected(new Set());
	};

	const changeSort = (key: SessionSortKey): void => {
		setSort(previous =>
			previous.key === key
				? { key, dir: previous.dir === "asc" ? "desc" : "asc" }
				: { key, dir: key === "updatedAt" ? "desc" : "asc" },
		);
		setPage(1);
	};

	// ── last prompt per visible row (one batched read) ───────────────────
	const promptsRef = useRef(new Map<string, string | null>());
	const [, refreshPrompts] = useState(0);
	useEffect(() => {
		if (!rpc || visibleIds.length === 0) return;
		const missing = visibleIds.filter(id => !promptsRef.current.has(id));
		if (missing.length === 0) return;
		let alive = true;
		void rpc
			.request<SessionLastPrompts>("session.lastPrompts", { sessionIds: missing })
			.then(map => {
				if (!alive) return;
				for (const id of missing) promptsRef.current.set(id, promptText(map?.[id]));
			})
			.catch(() => {
				if (!alive) return;
				for (const id of missing) promptsRef.current.set(id, null);
			})
			.finally(() => {
				if (alive) refreshPrompts(version => version + 1);
			});
		return () => {
			alive = false;
		};
	}, [rpc, visibleKey]);

	// ── expanded transcript ──────────────────────────────────────────────
	const transcriptsRef = useRef(new Map<string, SessionMessage[]>());
	const [, refreshTranscript] = useState(0);
	const detailHits = expandedId === null ? [] : (hitsBySession.get(expandedId) ?? []);
	const showMatches = detailScope === "matches" && detailHits.length > 0;
	const needsTranscript = expandedId !== null && !showMatches && !transcriptsRef.current.has(expandedId);

	useEffect(() => {
		if (!rpc || expandedId === null || !needsTranscript) return;
		let alive = true;
		void rpc
			.request<SessionMessage[]>("history.messages", {
				sessionId: expandedId,
				limit: TRANSCRIPT_LIMIT,
				tail: true,
			})
			.then(list => {
				if (!alive) return;
				transcriptsRef.current.set(expandedId, Array.isArray(list) ? list : []);
			})
			.catch(() => {
				if (!alive) return;
				transcriptsRef.current.set(expandedId, []);
			})
			.finally(() => {
				if (alive) refreshTranscript(version => version + 1);
			});
		return () => {
			alive = false;
		};
	}, [rpc, expandedId, needsTranscript]);

	const toggleExpanded = (view: SessionView): void => {
		setExpandedId(previous => (previous === view.id ? null : view.id));
		setDetailScope("matches");
		setExpandedMessages(new Set());
	};

	const toggleMessage = (key: string): void => {
		setExpandedMessages(previous => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

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
				setExpandedId(previous => (previous !== null && removed.has(previous) ? null : previous));
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
			<th scope="col" aria-sort={ariaSort} className="px-1.5 py-2 font-medium">
				<button
					type="button"
					className={`inline-flex max-w-full items-center gap-1 bg-transparent p-0 text-[11.5px] ${
						active ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"
					}`}
					onClick={() => changeSort(key)}
					title={t("settings.sessionManager.sortBy", { column: label })}
				>
					<span className="truncate">{label}</span>
					<span aria-hidden className="text-[10px] opacity-70">
						{active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
					</span>
				</button>
			</th>
		);
	};

	const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
	const hasArchiveTargets = selectedViews.some(view => view.status !== "archived");
	const hasUnarchiveTargets = selectedViews.some(view => view.status === "archived");

	const statusOf = (view: SessionView): { label: string; dot: string; title: string } => {
		if (view.status === "archived") {
			return {
				label: t("settings.archived"),
				dot: "bg-[var(--color-text-faint)]",
				title: t("settings.sessionManager.archivedAt", {
					time: formatSessionTime(view.completedAt),
				}),
			};
		}
		if (view.status === "running") {
			return { label: t("settings.inProgress"), dot: STATUS_DOT.pending, title: t("settings.inProgress") };
		}
		const outcome = view.outcome ?? "complete";
		return {
			label: t(STATUS_LABEL[outcome]),
			dot: STATUS_DOT[outcome],
			title: t("settings.sessionManager.finishedAt", { time: formatSessionTime(view.completedAt) }),
		};
	};

	const renderDetail = (view: SessionView): ReactNode => {
		const hits = hitsBySession.get(view.id) ?? [];
		const transcript = transcriptsRef.current.get(view.id);
		const rowsToShow = showMatches ? [...detailHits].sort(bySeq) : (transcript ?? []);
		const loading = !showMatches && transcript === undefined;
		const truncated = !showMatches && (transcript?.length ?? 0) >= TRANSCRIPT_LIMIT;
		return (
			<td colSpan={7} className="p-0">
				<div className="gui-session-detail">
					<div className="gui-session-detail-head">
						<span className="gui-session-detail-title">
							{showMatches
								? t("settings.sessionManager.messageHits", { count: hits.length })
								: t("settings.sessionManager.messageCount", { count: view.messageCount })}
						</span>
						{loading && (
							<span className="gui-session-detail-note">{t("settings.sessionManager.messagesLoading")}</span>
						)}
						{hits.length > 0 && (
							<Segmented
								ariaLabel={t("settings.sessionManager.onlyMatches")}
								value={detailScope}
								options={DETAIL_SCOPE_OPTIONS.map(option => ({ value: option.value, label: t(option.label) }))}
								onChange={value => setDetailScope(value)}
							/>
						)}
						{onOpenSession && (
							<button
								type="button"
								className="gui-btn gui-btn--small gui-session-detail-open"
								onClick={() => onOpenSession(view.id)}
							>
								{t("settings.sessionManager.openSession")}
							</button>
						)}
					</div>
					<div className="gui-session-detail-scroll">
						{loading ? (
							<div className="gui-session-detail-note">{t("settings.sessionManager.messagesLoading")}</div>
						) : rowsToShow.length === 0 ? (
							<div className="gui-session-detail-note">{t("settings.noMessages")}</div>
						) : (
							<>
								{truncated && (
									<div className="gui-session-detail-note">
										{t("settings.sessionManager.messagesTruncated", { count: TRANSCRIPT_LIMIT })}
									</div>
								)}
								{rowsToShow.map(message => {
									const key = `${message.sessionId}:${message.seq}`;
									return (
										<MessageRow
											key={key}
											message={message}
											query={showMatches ? term : ""}
											expanded={expandedMessages.has(key)}
											onToggleExpanded={() => toggleMessage(key)}
										/>
									);
								})}
							</>
						)}
					</div>
				</div>
			</td>
		);
	};

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
					{views.length === 0 ? (
						<p className="m-0 mt-1 text-[12px] text-[var(--color-text-faint)]">
							{t("settings.sessionManager.emptyHint")}
						</p>
					) : (
						<button type="button" className="gui-btn gui-btn--small mt-2" onClick={resetFilters}>
							{t("settings.sessionManager.reset")}
						</button>
					)}
				</div>
			);
		}
		return (
			<table className="gui-session-table w-full table-fixed border-collapse text-left text-[12px]">
				<colgroup>
					<col style={{ width: "4%" }} />
					<col style={{ width: "30%" }} />
					<col style={{ width: "15%" }} />
					<col style={{ width: "11%" }} />
					<col style={{ width: "19%" }} />
					<col style={{ width: "10%" }} />
					<col style={{ width: "11%" }} />
				</colgroup>
				<thead className="sticky top-0 z-[1] border-b border-[var(--border)] bg-[var(--color-surface)]">
					<tr>
						<th scope="col" className="px-1.5 py-2">
							<input
								type="checkbox"
								checked={allVisibleSelected}
								onChange={() => setSelected(previous => toggleAll(previous, visibleIds))}
								aria-label={t("settings.sessionManager.selectAll")}
							/>
						</th>
						{header("title", t("settings.sessionManager.sessionName"))}
						{header("project", t("settings.sessionManager.project"))}
						{header("status", t("settings.sessionManager.status"))}
						<th scope="col" className="px-1.5 py-2 font-medium">
							{t("settings.sessionManager.lastPrompt")}
						</th>
						{header("updatedAt", t("settings.sessionManager.lastUpdated"))}
						<th scope="col" className="px-1.5 py-2 text-right font-medium">
							{t("settings.sessionManager.actions")}
						</th>
					</tr>
				</thead>
				<tbody>
					{visible.map(view => {
						const prompt = promptsRef.current.get(view.id);
						const promptLabel =
							prompt === undefined ? t("settings.sessionManager.promptLoading") : (prompt ?? "—");
						const current = !canDelete(view);
						const expanded = expandedId === view.id;
						const hits = hitsBySession.get(view.id)?.length ?? 0;
						const status = statusOf(view);
						return (
							<Fragment key={view.id}>
								<tr className={expanded ? "gui-session-row--expanded" : undefined}>
									<td className="px-1.5 py-1.5 align-middle">
										<input
											type="checkbox"
											checked={selected.has(view.id)}
											onChange={() => setSelected(previous => toggleAll(previous, [view.id]))}
											aria-label={t("settings.sessionManager.selectRow", {
												title: view.title,
											})}
										/>
									</td>
									<td className="px-1.5 py-1.5 align-middle">
										<button
											type="button"
											className="gui-session-name"
											onClick={() => toggleExpanded(view)}
											aria-expanded={expanded}
											title={t("settings.sessionManager.expandRow", { title: view.title })}
										>
											<Icon
												name="arrow-down-s"
												className={`h-3 w-3 shrink-0 opacity-60${expanded ? "" : " -rotate-90"}`}
											/>
											<span className="truncate font-medium">{view.title}</span>
											{current && (
												<span className="gui-session-current">
													{t("settings.sessionManager.currentSession")}
												</span>
											)}
										</button>
										<div className="gui-session-meta" title={view.id}>
											<span className="truncate">{view.id}</span>
											{hits > 0 && (
												<span className="gui-session-hits">
													{t("settings.sessionManager.messageHits", { count: hits })}
												</span>
											)}
										</div>
									</td>
									<td
										className="truncate px-1.5 py-1.5 align-middle text-[var(--color-text-muted)]"
										title={view.cwd ?? undefined}
									>
										{view.cwd === null ? t("settings.sessionManager.noProject") : view.project}
									</td>
									<td className="px-1.5 py-1.5 align-middle" title={status.title}>
										<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
											<span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} />
											<span className="truncate">{status.label}</span>
										</span>
									</td>
									<td
										className="truncate px-1.5 py-1.5 align-middle text-[var(--color-text-muted)]"
										title={prompt ?? undefined}
									>
										{promptLabel}
									</td>
									<td className="whitespace-nowrap px-1.5 py-1.5 align-middle tabular-nums">
										{formatSessionTime(view.updatedAt)}
									</td>
									<td className="px-1.5 py-1.5 text-right align-middle">
										<div className="inline-flex items-center">
											{onOpenSession && (
												<button
													type="button"
													className="gui-pane-action w-auto px-1"
													disabled={busy || current}
													title={t("settings.sessionManager.openSession")}
													aria-label={t("settings.sessionManager.openSession")}
													onClick={() => onOpenSession(view.id)}
												>
													<Icon name="chat-history" className="h-3.5 w-3.5" />
												</button>
											)}
											{view.status === "archived" ? (
												<button
													type="button"
													className="gui-pane-action w-auto px-1"
													title={t("settings.unarchive")}
													aria-label={t("settings.unarchive")}
													onClick={() => unarchive(view.id)}
												>
													<Icon name="restart" className="h-3.5 w-3.5" />
												</button>
											) : (
												<button
													type="button"
													className="gui-pane-action w-auto px-1"
													title={t("settings.archive")}
													aria-label={t("settings.archive")}
													onClick={() => archiveOne(view)}
												>
													<Icon name="inbox-archive" className="h-3.5 w-3.5" />
												</button>
											)}
											<button
												type="button"
												className="gui-pane-action w-auto px-1"
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
								{expanded && renderDetail(view)}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		);
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.sessionManager.title")}</h2>
			<p className="gui-settings-page-desc">{t("settings.sessionManager.description")}</p>

			<div className="mt-4 flex flex-wrap items-center gap-2">
				<select
					className="gui-settings-select"
					style={{ minWidth: 120 }}
					value={filters.project}
					aria-label={t("settings.sessionManager.project")}
					onChange={event => {
						setFilters(previous => ({ ...previous, project: event.target.value }));
						setPage(1);
					}}
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
					style={{ minWidth: 100 }}
					value={filters.status}
					aria-label={t("settings.sessionManager.status")}
					onChange={event => {
						setFilters(previous => ({ ...previous, status: event.target.value as StatusFilter }));
						setPage(1);
					}}
				>
					{STATUS_OPTIONS.map(option => (
						<option key={option.value} value={option.value}>
							{t(option.label)}
						</option>
					))}
				</select>
				<select
					className="gui-settings-select"
					style={{ minWidth: 100 }}
					value={filters.days}
					aria-label={t("settings.sessionManager.updatedWithin")}
					onChange={event => {
						setFilters(previous => ({ ...previous, days: Number(event.target.value) }));
						setPage(1);
					}}
				>
					{DAY_OPTIONS.map(option => (
						<option key={option.value} value={option.value}>
							{t(option.label)}
						</option>
					))}
				</select>
				<label className="gui-settings-search min-w-[160px] flex-1" style={{ margin: 0 }}>
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
					{searching && <Icon name="loader-4" className="h-3.5 w-3.5 flex-none animate-spin opacity-60" />}
				</label>
				{filtersActive && (
					<button type="button" className="gui-btn gui-btn--small" onClick={resetFilters}>
						{t("settings.sessionManager.reset")}
					</button>
				)}
				<button
					type="button"
					className="gui-pane-action w-auto px-1.5"
					title={t("settings.sessionManager.refresh")}
					aria-label={t("settings.sessionManager.refresh")}
					onClick={() => {
						promptsRef.current.clear();
						transcriptsRef.current.clear();
						setReloadToken(token => token + 1);
					}}
				>
					<Icon name="refresh" className="h-3.5 w-3.5" />
				</button>
			</div>

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
