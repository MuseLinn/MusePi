/**
 * Session info card (desktop GUI).
 *
 * The right panel owns the session's metadata while it is open, so this tile is
 * the collapsed panel's stand-in: it repeats the few facts that otherwise cost a
 * panel open — session title, model reference ("provider/id"), working-tree diff
 * totals, live/ended subagents, todo-board progress, the MCP connectors the
 * session may use, running plugins, the open panel tabs, and the surfaces that
 * can still be opened here. It has two seats:
 *
 * - `dock`: an independent glass column between the chat column and the panel
 *   host, with its own scroll. Used while the panel is collapsed and the shared
 *   row can still leave the transcript a usable width.
 * - `float`: the same tile over the transcript's right edge, inside the chat
 *   column, when the panel is open (manual reveal) or the row is too narrow for
 *   a docked column. It starts below the chat card's header row and paints
 *   under menus and tooltips.
 *
 * Wiring split: app.tsx owns the open state (per-session, see
 * `useSessionInfoCardVisibility`), ChatView picks the seat and supplies the panel
 * tabs + surface callbacks, and this module reads only what the daemon already
 * exposes — `session.contextUsage` for the model, `git.numstat` for the diff
 * totals, `connectors.list` for the MCP servers, and the shared extension
 * registry for running plugins.
 *
 * The connectors and plugins readouts are the session's only entry points for
 * those two choices: the composer carries no second copy. Subagent and todo
 * rows are readouts too — they open the trajectory surface instead of
 * duplicating its timeline.
 */
import { type TranslationKey, t } from "@musepi/client-core";
import { fmtCost, fmtDuration } from "@musepi/client-core/src/lib/format";
import { agentProgressFraction } from "@musepi/client-core/src/tool-render/tools/task";
import type { SessionEntry, SubagentProgressPayload } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import type { PanelTab } from "../lib/panel-tabs";
import type { RpcClient } from "../lib/rpc";
import type { SessionInfoPluginRow, SessionInfoSlotData } from "../lib/slot-host";
import { SESSION_INFO_SLOT, SlotComponentHost, useExtensionRegistry } from "../lib/slot-host";
import { readHiddenSurfaces, SURFACE_HIDDEN_KEY, SURFACES, surfaceVisible } from "../lib/surfaces/registry";
import { Icon, type IconName } from "../vendor/oc-icons";
import { ConnectorPanel, nextSelection, useConnectors } from "./composer/connector-panel";
import { ExtensionStatusCard } from "./ExtensionStatusCard";
import { Reveal } from "./Reveal";

/** One preference per session; the `musepi-gui-` prefix is the GUI's key rule. */
const SESSION_INFO_STORAGE_PREFIX = "musepi-gui-session-info-";

/**
 * Width the docked column reserves for itself, matching the right panel and the
 * status cards. gui-chat.css carries the same number for `.gui-session-info`;
 * the constant is what ChatView budgets against.
 */
export const SESSION_INFO_DOCK_WIDTH_PX = 288;

/** Chat column width the dock must leave free; under this the transcript
 *  stops reading as a conversation and the float seat is the better trade. */
const DOCK_MIN_CHAT_COLUMN_PX = 560;

/**
 * Everything the shared row spends before the chat column sees a pixel: the
 * dock (288 + its gutters), the rail (44 + its gutters) and the folded right
 * panel's leftover gutter. Below this row width ChatView floats the tile
 * instead of docking it.
 */
export const SESSION_INFO_DOCK_MIN_ROW_PX = SESSION_INFO_DOCK_WIDTH_PX + 16 + 44 + 16 + 8 + DOCK_MIN_CHAT_COLUMN_PX;

/** Tabs past this fold behind 「查看更多」 so the card stays a glanceable tile. */
const VISIBLE_TAB_LIMIT = 6;

/** Same cadence as the other working-tree readouts — they describe one tree. */
const POLL_MS = 15_000;

/** Wire shape of `session.contextUsage` (only the model field is read here). */
interface UsageView {
	model?: string | null;
}

/** Wire shape of `git.numstat`. */
interface NumstatView {
	files?: Array<{ path: string; added: number; removed: number; binary: boolean }>;
	error?: string;
}

/** Current-branch PR from `github.prStatus`. */
interface PrView {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	url: string;
}

interface ChangesView {
	added: number;
	removed: number;
	files: number;
}

type UsageState = "loading" | "ready" | "error";
type ChangesState = "loading" | "ready" | "none" | "error";

function sessionInfoStorageKey(sessionId: string): string {
	return `${SESSION_INFO_STORAGE_PREFIX}${sessionId}`;
}

/** Stored preference, or null when this session never chose. */
function readSessionInfoPreference(sessionId: string | null): boolean | null {
	if (!sessionId) return null;
	try {
		const raw = localStorage.getItem(sessionInfoStorageKey(sessionId));
		if (raw === "1") return true;
		if (raw === "0") return false;
		return null;
	} catch {
		return null;
	}
}

function writeSessionInfoPreference(sessionId: string | null, open: boolean): void {
	if (!sessionId) return;
	try {
		localStorage.setItem(sessionInfoStorageKey(sessionId), open ? "1" : "0");
	} catch {
		/* Storage full / disabled — the card's visibility is cosmetic. */
	}
}

interface SessionInfoVisibility {
	open: boolean;
	toggle(): void;
}

/**
 * Per-session open state.
 *
 * The panel's own state supplies the DEFAULT: a collapsed panel shows the card,
 * an expanded one hides it. A manual toggle wins until the panel next changes
 * state; switching sessions restores that session's stored choice instead of
 * carrying the previous session's toggle across.
 */
export function useSessionInfoCardVisibility({
	sessionId,
	panelOpen,
}: {
	sessionId: string | null;
	panelOpen: boolean;
}): SessionInfoVisibility {
	const [open, setOpen] = useState<boolean>(() => readSessionInfoPreference(sessionId) ?? !panelOpen);
	// Last panel state this hook observed. Comparing against it makes the panel
	// effect a real-change trigger only: a session switch must not reset the
	// per-session choice it just restored.
	const panelOpenRef = useRef(panelOpen);

	useEffect(() => {
		setOpen(readSessionInfoPreference(sessionId) ?? !panelOpenRef.current);
	}, [sessionId]);

	useEffect(() => {
		if (panelOpenRef.current === panelOpen) return;
		panelOpenRef.current = panelOpen;
		const next = !panelOpen;
		setOpen(next);
		writeSessionInfoPreference(sessionId, next);
	}, [panelOpen, sessionId]);

	const toggle = useCallback((): void => {
		setOpen(current => {
			const next = !current;
			writeSessionInfoPreference(sessionId, next);
			return next;
		});
	}, [sessionId]);

	return { open, toggle };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasChangesOf(changes: ChangesView | null): changes is ChangesView {
	return changes !== null && changes.files > 0;
}

/** A subagent still producing progress (vs. a finished one). */
const isLiveAgent = (p: SubagentProgressPayload): boolean =>
	p.progress.status === "pending" || p.progress.status === "running";

/** Latest todo-tool snapshot from the transcript (result details carry
 *  `{ phases: [{ name, tasks: [{ content, status }] }] }`). Returns null
 *  when the session has no todo board yet. */
function latestTodo(entries: readonly SessionEntry[]): { done: number; total: number; current: string | null } | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "message") continue;
		const msg = e.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo" || msg.isError) continue;
		const phases = (msg.details as { phases?: unknown } | null)?.phases;
		if (!Array.isArray(phases)) continue;
		let total = 0;
		let done = 0;
		let current: string | null = null;
		for (const phase of phases) {
			if (!phase || typeof phase !== "object") continue;
			const tasks = (phase as { tasks?: unknown }).tasks;
			if (!Array.isArray(tasks)) continue;
			for (const task of tasks) {
				if (!task || typeof task !== "object") continue;
				const { content, status } = task as { content?: unknown; status?: unknown };
				if (typeof content !== "string") continue;
				total++;
				if (status === "completed") done++;
				else if (status === "in_progress" && current === null) current = content;
			}
		}
		if (total > 0) return { done, total, current };
	}
	return null;
}

/** Collapsible card section — same disclosure language as the plugins row. */
function InfoSection({
	title,
	trailing,
	children,
}: {
	title: string;
	trailing?: ReactNode;
	children: ReactNode;
}): ReactNode {
	const [open, setOpen] = useState(true);
	return (
		<section className="gui-session-info-section">
			<button
				type="button"
				className="gui-session-info-section-head"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
			>
				<span className="gui-session-info-section-label">{title}</span>
				{trailing}
				<Icon
					name="arrow-down-s"
					className={`gui-session-info-chev${open ? "" : " gui-session-info-chev--closed"}`}
				/>
			</button>
			<Reveal open={open}>{children}</Reveal>
		</section>
	);
}

/**
 * 内置「插件」分区 —— `chat.session-info.plugins` 没有可渲染占据者
 * (插件停用、编译失败或旧 daemon 不下发组件)时的回退。
 *
 * 标记、文案与折叠语言与插件版分区一致:切换贡献者不改变卡片外观。
 */
function SessionInfoPluginsFallback({ sessionInfo }: { sessionInfo: SessionInfoSlotData }): ReactNode {
	const [open, setOpen] = useState(false);
	const { runningPlugins, pluginEntries } = sessionInfo;
	return (
		<section className="gui-session-info-plugins" data-state={runningPlugins > 0 ? "running" : "idle"}>
			<button
				type="button"
				className="gui-session-info-plugins-head"
				aria-expanded={open}
				title={t("settings.extensionsRunning", { count: String(runningPlugins) })}
				onClick={() => setOpen(value => !value)}
			>
				<Icon name="plug" className="gui-session-info-row-icon" />
				<span className="gui-session-info-section-label">{t("general.sessionInfoPlugins")}</span>
				<span className="gui-session-info-count">{`${runningPlugins}/${pluginEntries.length}`}</span>
				<Icon
					name="arrow-down-s"
					className={`gui-session-info-chev${open ? "" : " gui-session-info-chev--closed"}`}
				/>
			</button>
			<Reveal open={open}>
				<ul className="gui-session-info-list">
					{pluginEntries.map(entry => (
						<li key={entry.id}>
							<div className="gui-session-info-plugin" title={entry.label}>
								<span
									className={`gui-session-info-dot${entry.active ? " gui-session-info-dot--active" : ""}`}
									aria-hidden="true"
								/>
								<span className="gui-session-info-item-label">{entry.label}</span>
								<span className="gui-session-info-plugin-state">
									{entry.active ? t("settings.extensionsStateRunning") : t("settings.extensionsStateDisabled")}
								</span>
							</div>
						</li>
					))}
				</ul>
			</Reveal>
		</section>
	);
}

interface SessionInfoCardProps {
	sessionId: string | null;
	rpc: RpcClient | null;
	/** Working tree the diff totals describe. */
	cwd?: string | null;
	/** Session title; falls back to the untitled-session copy. */
	title?: string | null;
	/** Open panel tabs, in strip order. */
	tabs: readonly PanelTab[];
	activeTabId?: string | null;
	/** Subagent progress keyed by agent id; ended agents stay in the map. */
	progress?: ReadonlyMap<string, SubagentProgressPayload> | null;
	/** Transcript entries, read for the latest todo-board snapshot. */
	entries?: readonly SessionEntry[];
	/** Whether the session is working — keeps an unfinished todo board visible
	 *  while every task is still pending. */
	working?: boolean;
	/** Seat: a docked column or the floating card. ChatView picks it (panel
	 *  state + measured row width); the tile itself only paints the difference. */
	mode?: "dock" | "float";
	/** Float only: px from the chat column's top — below the chat header row. */
	top?: number;
	/** Playing the exit animation; the host unmounts the card afterwards. */
	closing?: boolean;
	onSelectTab?(id: string): void;
	onOpenSurface?(id: string): void;
	/** Open the settings pane at a section — the connector section's
	 *  manage entry passes "mcp". */
	onOpenSettings?(section?: string): void;
}

export function SessionInfoCard({
	sessionId,
	rpc,
	cwd,
	title,
	tabs,
	activeTabId = null,
	progress = null,
	entries = [],
	working = false,
	mode = "float",
	top = 44,
	closing = false,
	onSelectTab,
	onOpenSurface,
	onOpenSettings,
}: SessionInfoCardProps): ReactNode {
	const [usage, setUsage] = useState<UsageView | null>(null);
	const [usageState, setUsageState] = useState<UsageState>("loading");
	const [changes, setChanges] = useState<ChangesView | null>(null);
	const [changesState, setChangesState] = useState<ChangesState>("loading");
	const [changesError, setChangesError] = useState<string | null>(null);
	const [pr, setPr] = useState<PrView | null>(null);
	const [reloadToken, setReloadToken] = useState(0);
	const [showAllTabs, setShowAllTabs] = useState(false);
	const [showAllSurfaces, setShowAllSurfaces] = useState(false);

	useEffect(() => {
		if (!rpc || !sessionId) return;
		let alive = true;
		const load = async (): Promise<void> => {
			const [usageResult, numstatResult, prResult] = await Promise.allSettled([
				rpc.request<UsageView | null>("session.contextUsage", { sessionId }),
				cwd ? rpc.request<NumstatView>("git.numstat", { cwd }) : Promise.resolve(null),
				cwd ? rpc.request<{ pr?: PrView | null }>("github.prStatus", { cwd }) : Promise.resolve(null),
			]);
			if (!alive) return;

			if (prResult.status === "fulfilled") setPr(prResult.value?.pr ?? null);
			else setPr(null);

			if (usageResult.status === "fulfilled") {
				setUsage({ model: usageResult.value?.model ?? null });
				setUsageState("ready");
			} else {
				setUsageState("error");
			}

			if (!cwd) {
				setChanges({ added: 0, removed: 0, files: 0 });
				setChangesState("none");
				setChangesError(null);
				return;
			}
			if (numstatResult.status === "rejected") {
				setChangesState("error");
				setChangesError(errorText(numstatResult.reason));
				return;
			}
			const value = numstatResult.value;
			const failure = typeof value?.error === "string" ? value.error : null;
			if (failure === "not a git repository") {
				// Outside a repository there is nothing to diff, and that is a
				// readout, not a failure.
				setChanges({ added: 0, removed: 0, files: 0 });
				setChangesState("none");
				setChangesError(null);
				return;
			}
			if (failure) {
				setChangesState("error");
				setChangesError(failure);
				return;
			}
			const files = value?.files ?? [];
			setChanges({
				added: files.reduce((sum, file) => sum + file.added, 0),
				removed: files.reduce((sum, file) => sum + file.removed, 0),
				files: files.length,
			});
			setChangesState("ready");
			setChangesError(null);
		};
		setUsageState("loading");
		setChangesState("loading");
		void load();
		const timer = setInterval(() => void load(), POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId, cwd, reloadToken]);

	// A hidden-surface edit in another part of the GUI arrives as a storage event;
	// re-reading on it keeps 「可打开」 honest without polling.
	const [hiddenSurfaces, setHiddenSurfaces] = useState<readonly string[]>(readHiddenSurfaces);
	useEffect(() => {
		const onStorage = (event: StorageEvent): void => {
			if (event.key === SURFACE_HIDDEN_KEY) setHiddenSurfaces(readHiddenSurfaces());
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	// ── Connectors (MCP): which servers this session may use ────────────────
	// The panel below is the single picker; `useConnectors` owns the write-back
	// (`connectors.setSelected`) and the draft-to-live pending handoff.
	const {
		snapshot: connectorSnapshot,
		loadFailed: connectorsLoadFailed,
		setSelection: setConnectorSelection,
	} = useConnectors(rpc, sessionId, cwd);
	const connectorServers = connectorSnapshot?.servers ?? [];

	// ── Plugins: the shared extension registry the GUI's other hosts read ────
	// 分区组件(`chat.session-info.plugins`)与内置回退拿到的是同一份读数:
	// 卡片读注册表一次,counts 与 rows 都从这里出。
	const extensionRegistry = useExtensionRegistry(rpc);
	const pluginEntries = useMemo(
		() =>
			(extensionRegistry?.extensions ?? []).filter(
				entry => entry.kind === "plugin-module" || entry.kind === "extension-module",
			),
		[extensionRegistry],
	);
	const sessionInfo = useMemo<SessionInfoSlotData>(() => {
		const rows: SessionInfoPluginRow[] = pluginEntries.map(entry => ({
			id: entry.id,
			label: entry.displayName || entry.name || entry.id,
			active: entry.state === "active",
		}));
		return { runningPlugins: rows.filter(row => row.active).length, pluginEntries: rows };
	}, [pluginEntries]);

	// ── Subagents: live/ended split + per-agent elapsed timers ─────────────
	const liveAgents = useMemo(
		() => (progress ? [...progress.entries()].filter(([, entry]) => isLiveAgent(entry)) : []),
		[progress],
	);
	const endedAgents = useMemo(
		() => (progress ? [...progress.entries()].filter(([, entry]) => !isLiveAgent(entry)) : []),
		[progress],
	);
	const [endedOpen, setEndedOpen] = useState(false);
	// Elapsed seconds per agent id, measured from first sighting in this mount
	// (the wire payload carries no start timestamp).
	const firstSeenRef = useRef<Map<string, number>>(new Map());
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!progress || liveAgents.length === 0) return;
		const now = Date.now();
		for (const [id, entry] of progress) {
			if (isLiveAgent(entry) && !firstSeenRef.current.has(id)) firstSeenRef.current.set(id, now);
		}
		const timer = window.setInterval(() => setTick(value => value + 1), 1000);
		return () => window.clearInterval(timer);
	}, [progress, liveAgents.length]);
	const elapsed = useCallback((agentId: string): string => {
		const start = firstSeenRef.current.get(agentId);
		if (!start) return "";
		const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	}, []);

	// ── Todo board progress ────────────────────────────────────────────────
	const todo = useMemo(() => latestTodo(entries), [entries]);
	// An unfinished board stays visible while the session works even before the
	// first task flips to in_progress; a finished board drops out of the card.
	const showTodo = Boolean(todo && (todo.current || working) && todo.done < todo.total);

	const openSurfaces = useMemo(() => new Set(tabs.map(item => item.surface)), [tabs]);
	const surfaces = useMemo(() => {
		const hidden = new Set(hiddenSurfaces);
		return SURFACES.filter(
			surface =>
				!hidden.has(surface.id) && surfaceVisible(surface, { rpc, sessionId, cwd: cwd ?? undefined, openSurfaces }),
		);
	}, [rpc, sessionId, cwd, openSurfaces, hiddenSurfaces]);

	const visibleTabs = showAllTabs ? tabs : tabs.slice(0, VISIBLE_TAB_LIMIT);
	const foldedTabCount = tabs.length - visibleTabs.length;
	const visibleSurfaces = showAllSurfaces ? surfaces : surfaces.slice(0, VISIBLE_TAB_LIMIT);
	const foldedSurfaceCount = surfaces.length - visibleSurfaces.length;
	const sessionTitle = title?.trim() || t("general.sessionInfoUntitled");
	const model = usage?.model ?? null;
	const retry = useCallback((): void => setReloadToken(token => token + 1), []);

	const floating = mode === "float";
	return (
		<aside
			className={`gui-session-info gui-session-info--${mode}${closing ? " gui-session-info--closing" : ""}`}
			role="region"
			aria-label={t("sessionInfo.title")}
			data-mode={mode}
			/* Float geometry only: the dock is an in-flow flex column whose box
			 * and scroll come from CSS. Inline top on the dock would fight the
			 * card gutter and detach it from the column it shares with the chat. */
			style={floating ? { top: `${top}px`, maxHeight: `calc(100% - ${top + 12}px)` } : undefined}
		>
			<header className="gui-session-info-head">
				<Icon name="information" className="gui-session-info-head-icon" />
				<span className="gui-session-info-title" title={sessionTitle}>
					{sessionTitle}
				</span>
			</header>

			<div className="gui-session-info-model" data-state={usageState} title={model ?? undefined}>
				<Icon name="ai-agent" className="gui-session-info-row-icon" />
				<span className="gui-session-info-row-label">{t("sessionInfo.model")}</span>
				<span className="gui-session-info-model-value">
					{model ?? (usageState === "loading" ? t("sessionInfo.loading") : t("sessionInfo.unavailable"))}
				</span>
			</div>

			<section className="gui-session-info-changes" data-state={changesState}>
				<div className="gui-session-info-section-label">{t("general.sessionInfoChanges")}</div>
				{changesState === "loading" ? (
					<p className="gui-session-info-note">{t("sessionInfo.loading")}</p>
				) : changesState === "error" ? (
					<div className="gui-session-info-error" role="alert">
						<span className="gui-session-info-note">{t("sessionInfo.error")}</span>
						{changesError ? <span className="gui-session-info-error-detail">{changesError}</span> : null}
						<button type="button" className="gui-session-info-retry" onClick={retry}>
							{t("sessionInfo.retry")}
						</button>
					</div>
				) : changesState === "ready" && hasChangesOf(changes) ? (
					<button
						type="button"
						className="gui-session-info-nums gui-session-info-nums--link"
						title={t("general.sessionInfoChanges")}
						onClick={() => onOpenSurface?.("git")}
					>
						<span className="gui-session-info-num-add">+{changes.added}</span>
						<span className="gui-session-info-num-del">−{changes.removed}</span>
					</button>
				) : (
					<p className="gui-session-info-note">{t("general.sessionInfoNoChanges")}</p>
				)}
			</section>

			{pr ? (
				<button
					type="button"
					className="gui-session-info-pr"
					title={pr.title}
					onClick={() => void openExternalUrl(pr.url)}
				>
					<Icon name="git-pull-request" className="gui-session-info-row-icon" />
					<span className="gui-session-info-item-label">{`PR #${pr.number}`}</span>
					<span className="gui-session-info-count">
						{pr.isDraft
							? t("general.prDraft")
							: pr.state.toLowerCase() === "merged"
								? t("general.prStateMerged")
								: pr.state.toLowerCase() === "closed"
									? t("general.prStateClosed")
									: t("general.prStateOpen")}
					</span>
				</button>
			) : null}

			{liveAgents.length > 0 || endedAgents.length > 0 ? (
				<InfoSection
					title={t("general.agents")}
					trailing={
						liveAgents.length > 0 ? (
							<span className="gui-session-info-count gui-session-info-count--live">{liveAgents.length}</span>
						) : undefined
					}
				>
					<div className="gui-session-info-agents">
						{liveAgents.map(([id, entry]) => {
							// Same fraction the TUI task card and the guest swarm card use,
							// so a row reads the same progress everywhere.
							const pct = Math.round(agentProgressFraction(entry.progress) * 100);
							return (
								<button
									key={id}
									type="button"
									className="gui-session-info-agent"
									title={entry.task}
									onClick={() => onOpenSurface?.("trajectory")}
								>
									<Icon name="loader-4" className="gui-session-info-row-icon gui-session-info-spin" />
									<span className="gui-session-info-item-label">
										{entry.agent}
										{entry.task ? ` · ${entry.task}` : ""}
									</span>
									<span className="gui-session-info-bar" aria-hidden="true">
										<span className="tv-swarm-bar-fill" style={{ width: `${pct}%` }} />
									</span>
									<span className="gui-session-info-elapsed">{elapsed(id)}</span>
									{entry.progress.cost > 0 ? (
										<span className="gui-session-info-elapsed">{fmtCost(entry.progress.cost)}</span>
									) : null}
								</button>
							);
						})}
						{endedAgents.length > 0 ? (
							<button
								type="button"
								className="gui-session-info-agent gui-session-info-agent--ended"
								aria-expanded={endedOpen}
								onClick={() => setEndedOpen(value => !value)}
							>
								<Icon
									name="arrow-down-s"
									className={`gui-session-info-chev${endedOpen ? "" : " gui-session-info-chev--closed"}`}
								/>
								<span className="gui-session-info-item-label">{t("general.ended")}</span>
								<span className="gui-session-info-count">{endedAgents.length}</span>
							</button>
						) : null}
						<Reveal open={endedOpen}>
							<ul className="gui-session-info-list">
								{endedAgents.map(([id, entry]) => (
									<li key={id}>
										<button
											type="button"
											className="gui-session-info-agent gui-session-info-agent--ended"
											title={entry.task}
											onClick={() => onOpenSurface?.("trajectory")}
										>
											<Icon name="check" className="gui-session-info-row-icon" />
											<span className="gui-session-info-item-label">{entry.agent}</span>
											<span className="gui-session-info-elapsed">
												{entry.progress.durationMs > 0
													? fmtDuration(entry.progress.durationMs)
													: elapsed(id)}
											</span>
											{entry.progress.cost > 0 ? (
												<span className="gui-session-info-elapsed">{fmtCost(entry.progress.cost)}</span>
											) : null}
										</button>
									</li>
								))}
							</ul>
						</Reveal>
					</div>
				</InfoSection>
			) : null}

			{showTodo && todo ? (
				<InfoSection
					title={t("general.todoProgress")}
					trailing={<span className="gui-session-info-count">{`${todo.done}/${todo.total}`}</span>}
				>
					<button
						type="button"
						className="gui-session-info-agent"
						title={todo.current ?? undefined}
						onClick={() => onOpenSurface?.("trajectory")}
					>
						<Icon name="list-check-2" className="gui-session-info-row-icon" />
						<span className="gui-session-info-item-label">{todo.current ?? t("general.todoProgress")}</span>
					</button>
				</InfoSection>
			) : null}

			{/* 连接器分区始终渲染：没有配置任何 MCP 服务器时它不是空白，而是
			 * 「未连接连接器」+ 管理入口 —— 信息卡是会话侧唯一的连接器入口，
			 * 新用户必须先看到去哪里添加。 */}
			{connectorServers.length > 0 ? (
				<section className="gui-session-info-connectors">
					<ConnectorPanel
						snapshot={connectorSnapshot}
						loadFailed={connectorsLoadFailed}
						onToggleServer={name =>
							connectorSnapshot && setConnectorSelection(nextSelection(connectorSnapshot, name))
						}
						onToggleServers={names =>
							setConnectorSelection(names.length === connectorSnapshot?.servers.length ? null : names)
						}
						onSelectAll={() => setConnectorSelection([])}
						onUseAll={() => setConnectorSelection(null)}
					/>
					<button
						type="button"
						className="gui-connector-link gui-session-info-manage-connectors"
						onClick={() => onOpenSettings?.("mcp")}
					>
						{t("settings.mcpServers")}
					</button>
				</section>
			) : (
				<section className="gui-session-info-connectors gui-session-info-connectors--empty flex flex-col gap-1">
					<div className="gui-session-info-section-label">{t("tools.connectorsPanelTitle")}</div>
					<p className="gui-session-info-note">{t("settings.mcpSettings")}</p>
					<button
						type="button"
						className="gui-connector-link gui-session-info-manage-connectors self-start"
						onClick={() => onOpenSettings?.("mcp")}
					>
						{t("settings.mcpServers")}
					</button>
				</section>
			)}

			{/* 「插件」分区是 Cordis 贡献点(chat.session-info.plugins):插件停用或
			 *  编译失败时渲染下方内置同构列表,卡片不留白。分区上方的状态条把运行
			 *  读数提到一眼可见的位置,点开仍是逐个扩展的运行/禁用明细。 */}
			{pluginEntries.length > 0 ? (
				<section className="gui-session-info-plugins-group">
					<ExtensionStatusCard rpc={rpc} variant="inline" extensions={pluginEntries} />
					<SlotComponentHost
						rpc={rpc}
						slot={SESSION_INFO_SLOT}
						sessionInfo={sessionInfo}
						fallback={<SessionInfoPluginsFallback sessionInfo={sessionInfo} />}
					/>
				</section>
			) : null}

			<section className="gui-session-info-tabs">
				<div className="gui-session-info-section-label">{t("general.sessionInfoOpenTabs")}</div>
				{tabs.length === 0 ? (
					<p className="gui-session-info-note gui-session-info-tabs-empty">{t("general.sessionInfoNoTabs")}</p>
				) : (
					<ul className="gui-session-info-list">
						{visibleTabs.map(item => {
							const active = item.id === activeTabId;
							return (
								<li key={item.id}>
									<button
										type="button"
										className={`gui-session-info-item${active ? " gui-session-info-item--active" : ""}`}
										title={item.label}
										aria-current={active ? "true" : undefined}
										onClick={() => onSelectTab?.(item.id)}
									>
										<Icon name={surfaceIcon(item.surface)} className="gui-session-info-row-icon" />
										<span className="gui-session-info-item-label">{item.label}</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
				{foldedTabCount > 0 ? (
					<button type="button" className="gui-session-info-more" onClick={() => setShowAllTabs(true)}>
						{t("general.sessionInfoMore", { count: foldedTabCount })}
					</button>
				) : null}
			</section>

			<section className="gui-session-info-surfaces">
				<div className="gui-session-info-section-label">{t("general.sessionInfoSurfaces")}</div>
				<div className="gui-session-info-surface-grid">
					{visibleSurfaces.map(surface => (
						<button
							key={surface.id}
							type="button"
							className="gui-session-info-surface"
							title={t(surface.label as TranslationKey)}
							onClick={() => onOpenSurface?.(surface.id)}
						>
							<Icon name={surface.icon as IconName} className="gui-session-info-row-icon" />
							<span className="gui-session-info-surface-label">{t(surface.label as TranslationKey)}</span>
						</button>
					))}
				</div>
				{foldedSurfaceCount > 0 ? (
					<button type="button" className="gui-session-info-more" onClick={() => setShowAllSurfaces(true)}>
						{t("general.sessionInfoMore", { count: foldedSurfaceCount })}
					</button>
				) : null}
			</section>
		</aside>
	);
}

/** Tab icons come from the surface registry; extension tabs get a generic glyph. */
function surfaceIcon(surface: string): IconName {
	const descriptor = SURFACES.find(entry => entry.id === surface);
	return (descriptor?.icon ?? "stack") as IconName;
}
