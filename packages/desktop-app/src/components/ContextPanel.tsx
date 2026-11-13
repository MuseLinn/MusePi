import {
	type ClientRect,
	type CollisionDetection,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	TouchSensor,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	AgentsPanel,
	replaceTabs,
	Segmented,
	stripAnsi,
	type ToolRenderHost,
	type TranslationKey,
	t,
} from "@musepi/client-core";
import { fmtCost } from "@musepi/client-core/src/lib/format";
import type { AgentSnapshot, PdfQuoteAnchor } from "@musepi/pi-wire";
import {
	Columns2 as Columns2IconData,
	Maximize2 as Maximize2IconData,
	Minimize2 as Minimize2IconData,
	PanelLeft as PanelLeftIconData,
} from "lucide";
import { MorphIcon } from "morphicons/react";
import {
	Fragment,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { browserPanelDescriptor, browserTarget, reconcileBrowserPanelTabs } from "../lib/browser-panel-tabs";
import { BROWSER_ASK_SELECTION_SCRIPT, BROWSER_INSPECT_SCRIPT, type PickedElement } from "../lib/browser-scripts";
import { restrictToXAxis } from "../lib/dnd-axis";
import {
	canMoveEditorHistory,
	type EditorHistoryDirection,
	type EditorLocation,
	EMPTY_EDITOR_HISTORY,
	moveEditorHistory,
	pushEditorHistory,
	updateEditorHistoryCurrent,
} from "../lib/editor-navigation";
import { copyToClipboard, isElectron, openExternalUrl } from "../lib/electron";
import {
	discardFilePreviewBuffer,
	FILE_WORKSPACE_SURFACE,
	type FileWorkspaceHost,
	filePreviewBuffers,
	filePreviewWorkspacePath,
} from "../lib/file-workspace";
import {
	browserTabsForSession,
	closeTab as closeBrowserTab,
	getHostState as getBrowserHostState,
	reloadTab as reloadBrowserTab,
	renameTab as renameBrowserTab,
	selectTab as selectBrowserTab,
	setBrowserSession,
	setTabMuted as setBrowserTabMuted,
	subscribeHost as subscribeBrowserHost,
} from "../lib/managed-browser-host";
import {
	clearPanelMaximizedGeometry,
	exitPanelMaximized,
	getPanelMaximized,
	measurePanelMaximizedGeometry,
	panelMaximizeColumn,
	subscribePanelMaximize,
} from "../lib/panel-maximize";
import { type PanelDropZone, panelDropPointer, resolvePanelDrop } from "../lib/panel-tab-dnd";
import {
	closePanelTabs,
	nudgePanelSplitRatio,
	PANEL_SPLIT_DIVIDER_PX,
	type PanelColumn,
	type PanelTab,
	panelSplitRatio,
	panelSplitRatioAt,
	panelTabId,
	tabsInColumn,
} from "../lib/panel-tabs";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, maxPanelWidth } from "../lib/panel-width";
import { useConfirm, usePrompt } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionState } from "../lib/session-store";
import {
	RIGHT_PANEL_SLOT,
	resolveManagedBrowserPanelTab,
	SlotComponentHost,
	SlotComponentMount,
	selectPanelTabComponent,
} from "../lib/slot-host";
import { surfaceGlyph } from "../lib/surface-glyphs";
import {
	agentTabDescriptor,
	panelWidth,
	SURFACES,
	surfaceById,
	surfaceRequiresSession,
	writePanelWidth,
} from "../lib/surfaces/registry";
import type { UsePanelTabsResult } from "../lib/use-panel-tabs";
import { type PointerDragHandlers, usePointerDrag } from "../lib/use-pointer-drag";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon, type IconName } from "../vendor/oc-icons";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { ContextMenu } from "./ContextMenu";
import { FadeScroll } from "./FadeScroll";
import { GitPanel } from "./git-panel";
import { NotesPane } from "./notes-pane";
import { PanelTabsEmptyState } from "./panel-tabs-empty-state";
import { SideSessionView } from "./SideSessionView";
import { SubagentAvatar } from "./SubagentAvatar";
import { SubagentPanel, SubagentSessionView } from "./SubagentPanel";
import { SurfaceTabStripSortable } from "./surface-tabs";
import { TrajectoryView } from "./TrajectoryView";

/** Electron <webview> tag (embedded browser): the DOM element exposes
 *  loadURL/executeJavaScript/etc. at runtime; only the JSX shape is typed. */
declare global {
	namespace JSX {
		interface IntrinsicElements {
			webview: React.DetailedHTMLProps<
				React.HTMLAttributes<HTMLElement> & {
					src?: string;
					partition?: string;
					allowpopups?: boolean;
					webpreferences?: string;
					onDidFinishLoad?: () => void;
				},
				HTMLElement
			>;
		}
	}
}

/** ZCode right-pane tool views. Backends land behind daemon RPCs; until
 *  then each shows an honest placeholder with its future scope. (The
 *  terminal lives in the bottom dock now, not here.) Exported so the
 *  right-edge rail (RightRail) renders the same icon set. */

function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
	return String(n);
}

function BrowserPanelTabIcon({ favicon }: { favicon: string | null }): ReactNode {
	const [failed, setFailed] = useState(false);
	if (favicon && !failed) {
		return (
			<img
				src={favicon}
				alt=""
				className="h-3.5 w-3.5 rounded-[3px] object-contain"
				onError={() => setFailed(true)}
			/>
		);
	}
	return <Icon name={surfaceById("browser")?.icon as IconName} className="h-3.5 w-3.5" />;
}

/**
 * The owning session's subagent roster, read from the daemon's disk-backed
 * scan (`session.agents`) every 5s while the pane is visible. Live progress
 * rows come from the session store; this is the durable half — a finished
 * one-shot subagent leaves the registry, but its transcript and child session
 * stay on disk, so the roster must not be rebuilt from the registry alone.
 */
function useSubagentRoster(rpc: RpcClient, sessionId: string | null, enabled: boolean): readonly AgentSnapshot[] {
	const [roster, setRoster] = useState<readonly AgentSnapshot[]>([]);
	useEffect(() => {
		if (!sessionId) {
			setRoster([]);
			return;
		}
		if (!enabled) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<{
					agents: {
						id: string;
						sessionId: string;
						displayName: string;
						agentName?: string | null;
						kind: string;
						status: string;
						activity?: string | null;
						lastActivity?: number | null;
						hasSessionFile?: boolean;
					}[];
				}>("session.agents", { sessionId })
				.then(d => {
					if (!alive) return;
					setRoster(
						(d.agents ?? []).map(row => ({
							id: row.id,
							displayName: row.displayName,
							kind: "sub" as const,
							parentId: sessionId,
							status:
								row.status === "running" ||
								row.status === "idle" ||
								row.status === "parked" ||
								row.status === "aborted"
									? row.status
									: "idle",
							hasSessionFile: row.hasSessionFile !== false,
							createdAt: row.lastActivity ?? 0,
							lastActivity: row.lastActivity ?? 0,
							sessionId: row.sessionId,
							...(row.activity ? { activity: row.activity } : undefined),
						})),
					);
				})
				.catch(() => {
					/* fail-open: keep the rows already shown */
				});
		};
		poll();
		const timer = setInterval(poll, 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId, enabled]);
	return roster;
}

/** Live rows first (status, progress, completion markers), enriched with the
 *  durable roster's child session id / summary, then the roster rows the
 *  store does not know about. One row per agent id. */
function mergeSubagentRoster(
	live: readonly AgentSnapshot[],
	roster: readonly AgentSnapshot[],
): readonly AgentSnapshot[] {
	if (roster.length === 0) return live;
	const persisted = new Map(roster.map(agent => [agent.id, agent]));
	const merged = live.map(agent => {
		const disk = persisted.get(agent.id);
		if (!disk) return agent;
		persisted.delete(agent.id);
		return {
			...agent,
			sessionId: agent.sessionId ?? disk.sessionId,
			activity: agent.activity ?? disk.activity,
			hasSessionFile: agent.hasSessionFile || disk.hasSessionFile,
		};
	});
	if (persisted.size === 0) return merged;
	const rest = [...persisted.values()].sort((a, b) => b.lastActivity - a.lastActivity);
	return [...merged, ...rest];
}

/**
 * Right pane — ZCode-style session tools: 上下文 / 文件 tabs plus a tool
 * rail (git graph, PRs, diff, notes, browser). The file tree and context
 * summary are live; the tool views are framed placeholders waiting on
 * their daemon backends (the terminal lives in the bottom dock).
 */
export function ContextPanel({
	snap,
	rpc,
	className,
	open = true,
	openRequest = null,
	browserOpenRequest = null,
	onBrowserTakeover,
	extTabs = [],
	onViewChange,
	panelTabs,
	onExpandPanel,
	agentId,
	onAgentSelect,
	onOpenSession,
	onNewSession,
	agentHost,
	leafId,
	activePathIds,
	/** 激活路径过滤集(回退/切分支后时间线/统计只呈现当前分支)。 */
	pathEntries,
	onBranchTo,
	onSwitchTo,
	onForkAt,
	onJumpToEntry,
	planShowRequest,
	overviewEntries,
	overviewLoading,
	overviewError,
	onLoadOlderHistory,
	cwd: cwdOverride,
}: {
	/** 无会话时的目录（欢迎页右栏）：会话内仍以 `snap.state.cwd` 为准。 */
	cwd?: string;
	/** Materialized snapshot, passed down from ChatView's own store
	 *  subscription (a second useStore here double-subscribed the same
	 *  store for four fields — every notify ran two listeners). */
	snap: GuiSessionState | null;
	rpc: RpcClient;
	/** Optional extra class (inner-panel styling). */
	className?: string;
	/** Width-collapse state: `false` folds the panel to a 0px sliver
	 *  (ChatView keeps it mounted so the width animates on toggle). */
	open?: boolean;
	/** External reveal request (artifact cards / transcript paths):
	 *  switches to the files tab and previews the path. */
	openRequest?: {
		path: string;
		nonce: number;
		pdf?: PdfQuoteAnchor;
		quote?: string;
		line?: number;
		column?: number;
		pin?: boolean;
	} | null;
	/** External browser reveal (chat link click / agent browser.open):
	 *  switches to the browser tool and navigates the active tab. */
	browserOpenRequest?: { url: string; nonce: number } | null;
	/** Stop the current session turn while leaving the managed page intact. */
	onBrowserTakeover?(): void;
	/** Extension panel-tab slots (panel.tab.*); nav items live in the
	 *  RightRail — the panel only renders their content. */
	extTabs?: import("../lib/slot-host").SlotComponent[];
	/** 当前已累积的历史窗口，与对话共用同一分页数据。 */
	overviewEntries?: readonly unknown[] | null;
	/** 下一页历史正在加载。 */
	overviewLoading?: boolean;
	/** 更早历史不可达或加载失败——轨迹面板据此显示降级提示。 */
	overviewError?: boolean;
	/** 轨迹面板挂载或重试时只请求下一页。 */
	onLoadOlderHistory?(): void;
	/** Active view — DERIVED from the active panel tab inside this component
	 *  (tab-primary, docs §3.3.2): the panel body switches on the active
	 *  tab's surface, so a view/tab disagreement is unrepresentable.
	 *  onViewChange remains the navigation request channel (effects here
	 *  reveal files/browser; the rail and shortcuts land via ChatView). */
	onViewChange(view: string | null): void;
	/** Panel-level tab state (tab-primary model, docs §3.3.2): the strip at
	 *  the top of the panel hosts every open surface; the rail launches tabs. */
	panelTabs: UsePanelTabsResult;
	/** Expand a folded panel. The agent-activity reveal needs it (and only
	 *  it): the rail and ⌘-shortcut paths expand for the same reason. */
	onExpandPanel?(): void;
	/** Selected swarm subagent (swarm-card member row / roster row): its
	 *  trajectory detail docks over the pane as a layer — same panel, not a
	 *  second navigation surface. */
	agentId: string | null;
	onAgentSelect(id: string | null): void;
	/** Open a session as the main chat surface (sub-session rows in the
	 *  agents hub switch the whole view, same as clicking the sidebar row). */
	onOpenSession?(id: string): void;
	/** Start a session from file-selection toolbar text. */
	onNewSession?(text: string): void;
	/** Drill-down host for the docked detail (a nested task card opens
	 *  another subagent's transcript in place). */
	agentHost?: ToolRenderHost;
	/** Jump the transcript to an entry id (trajectory rows; provided by
	 *  ChatView — absent = trajectory rows render without jump action). */
	onJumpToEntry?(entryId: string): void;
	/** Layer-2 分支树(轨迹 Tree 模式):当前叶 + 活动路径 + 分支/fork 动作。 */
	leafId?: string | null;
	activePathIds?: ReadonlySet<string>;
	/** 激活路径过滤后的条目;null = 拓扑不可信,时间线回退全量。 */
	pathEntries?: readonly unknown[] | null;
	onBranchTo?(id: string): void;
	/** branchAt 纯切换(非 user 节点):leaf 落节点、不回填草稿——与
	 *  TrajectoryView 树行按 kind 分派的切换操作对应。 */
	onSwitchTo?(id: string): void;
	onForkAt?(id: string): void;
	/** modes.list catalog. Carried by the panel-shell payload; the panel itself
	 *  renders no mode row (the chat header owns the session's mode). */
	modeCatalog?: readonly unknown[] | null;
	/** `knowledge` show request (the agent opened a plan for the user): the
	 *  project-knowledge surface consumes it to open that plan once its list
	 *  has loaded. Nonce-bumped by ChatView so a repeat re-opens. */
	planShowRequest?: { directory: string; id: string; title: string; nonce: number } | null;
}): ReactNode {
	const cwd = snap?.state?.cwd ?? cwdOverride ?? "";
	const browserSessionId = snap?.sessionId ?? null;
	const subagentRoster = useSubagentRoster(rpc, browserSessionId, open);
	const rosterAgents = useMemo(
		() => mergeSubagentRoster(snap?.agents ?? [], subagentRoster),
		[snap?.agents, subagentRoster],
	);
	const browserHost = useSyncExternalStore(subscribeBrowserHost, getBrowserHostState, getBrowserHostState);
	const browserTabs = useMemo(
		() => browserTabsForSession(browserSessionId, browserHost),
		[browserSessionId, browserHost],
	);
	useEffect(() => setBrowserSession(browserSessionId), [browserSessionId]);
	// Runtime-only editor locations survive file-tab remounts, but never cross
	// workspaces. Ordinary cursor movement updates the current entry in place.
	const editorHistoryRef = useRef(EMPTY_EDITOR_HISTORY);
	const editorLocationRef = useRef<EditorLocation | null>(null);
	const [editorHistoryAvailability, setEditorHistoryAvailability] = useState({ back: false, forward: false });
	useEffect(() => {
		editorHistoryRef.current = EMPTY_EDITOR_HISTORY;
		editorLocationRef.current = null;
		setEditorHistoryAvailability({ back: false, forward: false });
	}, [cwd]);
	// Session stats: message count + wall-clock run time. P1-12: the count
	// and the first timestamp only move when the entry LIST shape changes —
	// a streaming content upsert replaces a message object in place — so
	// the O(n) scan gates on structureRev instead of running on every
	// streamed frame.
	const { messageCount, firstTs } = useMemo(() => {
		const entries = snap?.entries ?? [];
		return {
			messageCount: entries.filter(e => e.type === "message").length,
			firstTs: entries.find(e => typeof e.timestamp === "string")?.timestamp,
		};
	}, [snap?.structureRev]);
	const runMinutes =
		typeof firstTs === "string" ? Math.max(0, Math.round((Date.now() - new Date(firstTs).getTime()) / 60000)) : 0;

	// Cumulative token usage over every settled assistant message: input /
	// output / cache-read / cache-write buckets, their spend, and the cache hit
	// rate. The final usage of a round lands on
	// the same message through a content upsert — no structureRev bump — so the
	// memo also keys on `working`: the write→idle flip is that round's settle
	// signal.
	const usageTotals = useMemo(() => {
		const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
		for (const entry of snap?.entries ?? []) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "assistant") continue;
			const usage = message.usage;
			if (!usage) continue;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.totalTokens += usage.totalTokens;
			totals.cost += usage.cost?.total ?? 0;
		}
		return totals;
	}, [snap?.structureRev, snap?.working]);
	const cacheHitRate =
		usageTotals.cacheRead + usageTotals.input > 0
			? (usageTotals.cacheRead / (usageTotals.cacheRead + usageTotals.input)) * 100
			: null;

	// Tool selection is controlled from ChatView (shared with RightRail).
	// Context-window usage (session.contextUsage, same RPC as the header
	// ring): tokens / capacity / percent, polled while the panel lives.
	const [ctxUsage, setCtxUsage] = useState<{
		tokens: number;
		contextWindow: number;
		percent: number;
		model?: string | null;
	} | null>(null);
	useEffect(() => {
		if (!rpc || !snap?.sessionId) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<{ tokens: number; contextWindow: number; percent: number; model?: string | null } | null>(
					"session.contextUsage",
					{ sessionId: snap.sessionId },
				)
				.then(u => {
					if (alive && u) setCtxUsage(u);
				})
				.catch(() => {});
		};
		poll();
		// Event-driven freshness: poll only while the agent WORKS — the
		// `snap.working` flip re-runs this effect, so context usage lands
		// on the transition instead of a timer (idle = zero polling).
		if (!snap?.working) return;
		const t = setInterval(poll, 5000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [rpc, snap?.sessionId, snap?.working]);
	// Docked detail snapshot: the selection is owned by ChatView (the
	// swarm-card member row in the transcript opens it too), so the layer
	// resolves against the live snapshot here. The agents-hub rows and the
	// sub-session rows open the agent TAB instead (agentTabDescriptor) —
	// the drawer is the transcript-driven secondary entry.
	const agent = agentId !== null ? (rosterAgents.find(a => a.id === agentId) ?? null) : null;
	const dockAgentId = agent?.id ?? null;
	const agentProgress = dockAgentId !== null ? (snap?.progress.get(dockAgentId)?.progress ?? null) : null;
	const dockOpen = agentId !== null;
	// The roster highlights whichever agent session is focused, so a tab the
	// user opened (or restored) reads as the selection the drawer used to own.
	const activeAgentTabKey = (() => {
		const active = panelTabs.tabs.find(tab => tab.id === panelTabs.activeId);
		return active?.surface === "agent" ? (active.dedupeKey ?? null) : null;
	})();
	// Surface-tab context menu (right-click): close / close others / close all.
	const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
	// Promise-based dialogs shared by the tab strip's tab menu and the file
	// close guard (rename prompt / discard-unsaved confirm).
	const { prompt } = usePrompt();
	const { confirm } = useConfirm();
	// Relay external reveal requests into the FilePane preview. One-shot per
	// nonce: the request object stays non-null forever (it is only ever
	// re-issued with a higher nonce), so an effect that re-runs for any other
	// reason must not re-navigate. That is exactly what happened to the
	// browser relay below — a re-render snapped the panel back to the browser
	// tab, so "open a new tab" looked broken.
	const revealedNonceRef = useRef({ file: 0, browser: 0 });
	useEffect(() => {
		if (!openRequest || openRequest.nonce === revealedNonceRef.current.file) return;
		if (!selectPanelTabComponent(extTabs, FILE_WORKSPACE_SURFACE)) return;
		revealedNonceRef.current.file = openRequest.nonce;
		onViewChange(FILE_WORKSPACE_SURFACE);
		const name = openRequest.path.split(/[\\/]/).pop() || openRequest.path;
		panelTabs.open({
			surface: FILE_WORKSPACE_SURFACE,
			target: openRequest.path,
			label: name,
			preview: openRequest.pin !== true,
		});
	}, [openRequest, onViewChange, panelTabs.open, extTabs]);

	const syncEditorHistoryAvailability = useCallback((): void => {
		setEditorHistoryAvailability({
			back: canMoveEditorHistory(editorHistoryRef.current, "back"),
			forward: canMoveEditorHistory(editorHistoryRef.current, "forward"),
		});
	}, []);
	const onEditorPositionChange = useCallback((location: EditorLocation): void => {
		editorLocationRef.current = location;
		editorHistoryRef.current = updateEditorHistoryCurrent(editorHistoryRef.current, location);
	}, []);
	const openEditorLocation = useCallback(
		(location: EditorLocation, newInstance: boolean): void => {
			const target = filePreviewWorkspacePath(cwd, location.path);
			const descriptor = {
				surface: "files" as const,
				target,
				label: location.path.split(/[\\/]/).pop() || location.path,
				preview: false,
			};
			const id = panelTabId(descriptor);
			const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
			const existing = panelTabs.tabs.find(tab => {
				if (tab.id === id) return true;
				if (tab.surface !== "files" || tab.target === null) return false;
				const tabTarget = filePreviewWorkspacePath(cwd, tab.target);
				return windows ? tabTarget.toLowerCase() === target.toLowerCase() : tabTarget === target;
			});
			// History never pins a preview merely because the user went back to it.
			if (existing && !newInstance) panelTabs.activate(existing.id);
			else panelTabs.open(descriptor, { forceNew: newInstance });
		},
		[cwd, panelTabs],
	);
	const onEditorNavigate = useCallback(
		(source: EditorLocation, target: EditorLocation): void => {
			editorHistoryRef.current = pushEditorHistory(editorHistoryRef.current, source, target);
			editorLocationRef.current = target;
			syncEditorHistoryAvailability();
			if (source.path !== target.path) openEditorLocation(target, true);
		},
		[openEditorLocation, syncEditorHistoryAvailability],
	);
	const navigateEditorHistory = useCallback(
		(direction: EditorHistoryDirection): EditorLocation | null => {
			const current = editorLocationRef.current;
			if (current) editorHistoryRef.current = updateEditorHistoryCurrent(editorHistoryRef.current, current);
			const result = moveEditorHistory(editorHistoryRef.current, direction);
			if (!result) return null;
			editorHistoryRef.current = result.history;
			editorLocationRef.current = result.location;
			syncEditorHistoryAvailability();
			openEditorLocation(result.location, false);
			return result.location;
		},
		[openEditorLocation, syncEditorHistoryAvailability],
	);

	const openBrowserPanel = useCallback(
		(options?: { column?: PanelColumn; forceNew?: boolean; url?: string }): string => {
			const managed = resolveManagedBrowserPanelTab({
				forceNew: options?.forceNew,
				url: options?.url,
				sessionId: browserSessionId,
			});
			const existing = panelTabs.tabs.find(tab => browserTarget(tab) === managed.id);
			panelTabs.open(browserPanelDescriptor(managed, t("tools.browserEmptyTab")), {
				column: options?.column ?? existing?.column,
				maxPerSurface: Number.POSITIVE_INFINITY,
			});
			return managed.id;
		},
		[browserSessionId, panelTabs.open, panelTabs.tabs],
	);
	const revealBrowserTab = useCallback(
		(tabId: string): void => {
			const managed = browserTabs.find(tab => tab.id === tabId);
			if (!managed) return;
			selectBrowserTab(tabId);
			const existing = panelTabs.tabs.find(tab => browserTarget(tab) === tabId);
			panelTabs.open(browserPanelDescriptor(managed, t("tools.browserEmptyTab")), {
				column: existing?.column,
				maxPerSurface: Number.POSITIVE_INFINITY,
			});
		},
		[browserTabs, panelTabs.open, panelTabs.tabs],
	);

	useEffect(() => {
		const desired = reconcileBrowserPanelTabs(panelTabs, browserTabs, t("tools.browserEmptyTab"));
		const current = new Map(panelTabs.tabs.filter(tab => tab.surface === "browser").map(tab => [tab.id, tab]));
		const desiredTabs = desired.tabs.filter(tab => tab.surface === "browser");
		const desiredIds = new Set(desiredTabs.map(tab => tab.id));
		const removed = [...current.keys()].filter(id => !desiredIds.has(id));
		if (removed.length > 0) panelTabs.closeMany(removed);
		for (const tab of desiredTabs) {
			const existing = current.get(tab.id);
			if (existing?.label === tab.label) continue;
			const managed = browserTabs.find(candidate => candidate.id === browserTarget(tab));
			if (!managed) continue;
			panelTabs.open(browserPanelDescriptor(managed, t("tools.browserEmptyTab")), {
				column: tab.column,
				reveal: false,
				now: tab.touchedAt,
				maxPerSurface: Number.POSITIVE_INFINITY,
			});
		}
	}, [browserTabs, panelTabs]);

	const hostActiveRef = useRef<string | null>(null);
	const panelCloseHostSyncRef = useRef(false);
	useEffect(() => {
		const activeId = browserHost.activeId;
		if (hostActiveRef.current === activeId) return;
		hostActiveRef.current = activeId;
		if (panelCloseHostSyncRef.current) {
			panelCloseHostSyncRef.current = false;
			return;
		}
		if (!activeId) return;
		const managed = browserTabs.find(tab => tab.id === activeId);
		if (!managed) return;
		const existing = panelTabs.tabs.find(tab => browserTarget(tab) === activeId);
		panelTabs.open(browserPanelDescriptor(managed, t("tools.browserEmptyTab")), {
			column: existing?.column,
			maxPerSurface: Number.POSITIVE_INFINITY,
		});
	}, [browserHost.activeId, browserTabs, panelTabs.open, panelTabs.tabs]);

	useEffect(() => {
		if (!browserOpenRequest || browserOpenRequest.nonce === revealedNonceRef.current.browser) return;
		revealedNonceRef.current.browser = browserOpenRequest.nonce;
		openBrowserPanel();
	}, [browserOpenRequest, openBrowserPanel]);

	const agentBrowserTabRef = useRef<string | null>(null);
	const maximizedRef = useRef(false);
	useEffect(() => {
		if (maximizedRef.current || !browserHost.agentActivity || !browserHost.activity) return;
		if (!browserTabs.some(tab => tab.id === browserHost.activity?.tabId)) return;
		const key = browserHost.activity.id;
		if (agentBrowserTabRef.current === key) return;
		agentBrowserTabRef.current = key;
		revealBrowserTab(browserHost.activity.tabId);
		if (!open) onExpandPanel?.();
	}, [browserHost.agentActivity, browserHost.activity, browserTabs, revealBrowserTab, open, onExpandPanel]);
	// One resizable width for the whole panel: switching tabs never resizes the
	// workspace. Width range 260–1200 (openchamber ContextPanel 380–1400,
	// adapted to the desktop surface).
	const [width, setWidth] = useState(() => Math.min(1200, Math.max(260, panelWidth(0.5))));
	// Maximize (openchamber fullscreen-surface / proma quick-window parity):
	// the panel floats over the session column at near-full width/height;
	// toggling off returns to the persisted width. The toggle itself lives in
	// lib/panel-maximize.ts: one document-level controller owns the store, the
	// class, the measured geometry and the FLIP. This component only reads the
	// store for the labels/icon and tags its buttons with `data-panel-maximize`.
	const maximized = useSyncExternalStore(subscribePanelMaximize, getPanelMaximized, getPanelMaximized);
	maximizedRef.current = maximized;
	// Width drag runs on the normalised pointer-drag primitive (capture +
	// preventDefault + pointerId filtering) rather than window listeners: the
	// ad-hoc version had no capture, so the pointer left the 4px strip and the
	// gesture kept selecting whatever text it crossed.
	const resizeStartRef = useRef(0);
	const resizeWidthRef = useRef(0);
	/** Snap points for right-panel width (px), taken only when the drag ends
	 *  within SNAP_RADIUS. The old rule snapped EVERY release to the nearest
	 *  point, so no other width was reachable (260–300 all landed on 300). */
	const SNAP_POINTS = [300, 480, 800];
	const SNAP_RADIUS = 24;
	const snapWidth = (w: number): number => {
		// Points are further apart than the radius, so at most one can match.
		for (const sp of SNAP_POINTS) {
			if (Math.abs(sp - w) <= SNAP_RADIUS) return sp;
		}
		return w;
	};
	// Width budget: the panel stops growing while the CHAT column keeps
	// MIN_CHAT_WIDTH. Both edges used to compute it are fixed during the drag
	// (the panel's right edge and the chat column's left edge), so the cap is
	// stable — and a fixed 1200 let the panel squeeze the chat out entirely.
	const panelRef = useRef<HTMLElement | null>(null);
	const maxWidthRef = useRef(MAX_PANEL_WIDTH);
	const measureCap = useCallback((): number => {
		const panel = panelRef.current?.getBoundingClientRect();
		// No transcript (welcome screen): there is no chat column to protect.
		const chat = document.querySelector(".gui-transcript")?.getBoundingClientRect();
		if (!panel || !chat) return MAX_PANEL_WIDTH;
		return maxPanelWidth(panel.right, chat.left);
	}, []);
	// Both endpoints ride refs. Reading a render-closure `width` on release
	// meant the snap used the value from the render that STARTED the drag, so
	// every drag snapped back to where it began (user: 拖拽会回弹).
	// Gesture shield (see .gui-drag-shield): armed on pointerdown — i.e. BEFORE
	// the 4px threshold — because the page is an OOPIF guest and a captured
	// pointer alone loses the moves that leave the handle, so the drag would
	// stall the moment it crossed onto the page.
	const [gestureShield, setGestureShield] = useState(false);
	const resizeDrag = usePointerDrag({
		onDragStart: () => {
			resizeStartRef.current = width;
			resizeWidthRef.current = width;
			maxWidthRef.current = measureCap();
			// body.gui-resizing freezes text selection (the drag used to select
			// everything it passed over) and disables the pane's width
			// transition, so the panel follows the pointer instead of animating
			// towards it.
			document.body.classList.add("gui-resizing");
		},
		onDragMove: ctx => {
			const budget = maxWidthRef.current;
			const next = Math.min(budget, Math.max(MIN_PANEL_WIDTH, resizeStartRef.current + (ctx.startX - ctx.x)));
			resizeWidthRef.current = next;
			setWidth(next);
		},
		onDragEnd: () => {
			document.body.classList.remove("gui-resizing");
			setGestureShield(false);
			// Snap first, then re-clamp: a snap point must not push the chat
			// below its minimum on a narrow window.
			const settled = Math.min(maxWidthRef.current, snapWidth(resizeWidthRef.current));
			setWidth(settled);
			writePanelWidth(settled);
		},
		onTap: () => setGestureShield(false),
	});
	// The handle stays live while MAXIMIZED too: it used to be nulled there, so
	// the edge looked (and was) inert — the panel is the widest it ever gets in
	// that state, which is exactly when a user grabs it (user: 拆分后宽度无法调节).
	// Grabbing it drops out of maximize and keeps dragging the docked width.
	const resizeHandleHandlers: PointerDragHandlers = {
		...resizeDrag,
		onPointerDown: e => {
			if (maximized) exitPanelMaximized(panelRef.current);
			setGestureShield(true);
			resizeDrag.onPointerDown(e);
		},
	};
	// The window drives the budget: shrinking it squeezes the panel, never the
	// chat column (and a persisted width from a wide window is clamped too).
	useEffect(() => {
		const clamp = (): void => {
			maxWidthRef.current = measureCap();
			setWidth(w => Math.min(w, maxWidthRef.current));
		};
		clamp();
		window.addEventListener("resize", clamp);
		return () => window.removeEventListener("resize", clamp);
	}, [measureCap]);
	// Maximized geometry: the panel takes the chat surface's box — the rounded
	// container the conversation occupies, same insets and radius — instead of
	// a viewport-relative overlay. The surface is not a box the panel can anchor
	// to (`.gui-scene-chat` is its nearest positioned ancestor), so its rect is
	// measured onto --pane-max-* and re-measured on every surface resize: a
	// window resize, sidebar toggle or rail drag keeps the panel flush instead
	// of leaving it off the container's insets.
	// Maximize geometry: measure the visible scene CARD (the session column, or
	// the welcome card), not .gui-chat-surface — the surface also contains this
	// panel, the rail and the collapsed panel's session-info dock, so the old
	// surface rect maximized the panel OVER the rail. The measured vars now
	// position ONLY the panel: there is no scrim to drive (user 2026-09-16 —
	// 最大化不要遮罩，正常缩放卡片尺寸即可). The owner of the measurement is
	// panel-maximize.ts; this effect re-runs it when the anchor resizes or the
	// panel folds. The session id is a dependency because the welcome↔session
	// swap replaces the anchor card WITHOUT resizing the surface — the old
	// observer would then watch a detached card and paint the previous scene's
	// box. Scene enter animations translate the card, so the final write waits
	// for animationend instead of capturing the mid-flight rect.
	useLayoutEffect(() => {
		const panel = panelRef.current;
		const column = panelMaximizeColumn(panel);
		if (!maximized || !open || !panel || !column) return;
		const measure = (): void => measurePanelMaximizedGeometry(panel);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(column, { box: "border-box" });
		const scene = column.closest<HTMLElement>(".gui-scene");
		scene?.addEventListener("animationend", measure);
		return () => {
			scene?.removeEventListener("animationend", measure);
			observer.disconnect();
			clearPanelMaximizedGeometry(panel);
		};
	}, [maximized, open, snap?.sessionId]);
	const panelClass = `gui-pane-right gui-pane-right--inner${open ? "" : " gui-pane-right--inner--closed"}${maximized ? " gui-pane-right--maximized" : ""}${className ? ` ${className}` : ""}`;
	// Header chrome title (nav unification): the rail owns navigation;
	// the strip labels the active view. `view` is derived from the active
	// PANEL TAB (tab-primary, docs §3.3.2) — the body switch and the strip
	// read one source, so they cannot disagree.
	const activePanelTab = panelTabs.tabs.find(t => t.id === panelTabs.activeId) ?? null;
	const view = activePanelTab?.surface ?? null;

	const activateTab = useCallback(
		(id: string): void => {
			const tab = panelTabs.tabs.find(candidate => candidate.id === id);
			const managedId = tab ? browserTarget(tab) : null;
			if (managedId) selectBrowserTab(managedId);
			panelTabs.activate(id);
		},
		[panelTabs],
	);

	const closeTabsFromPanel = useCallback(
		(ids: readonly string[]): void => {
			if (ids.length === 0) return;
			const closing = new Set(ids);
			const closesHostActive = panelTabs.tabs.some(
				tab => closing.has(tab.id) && browserTarget(tab) === browserHost.activeId,
			);
			if (closesHostActive) panelCloseHostSyncRef.current = true;
			const next = closePanelTabs(panelTabs, ids);
			panelTabs.closeMany(ids);
			for (const tab of panelTabs.tabs) {
				if (!closing.has(tab.id)) continue;
				const managedId = browserTarget(tab);
				if (managedId) closeBrowserTab(managedId);
			}
			const nextActive = next.tabs.find(tab => tab.id === next.activeId);
			const nextManagedId = nextActive ? browserTarget(nextActive) : null;
			if (nextManagedId) selectBrowserTab(nextManagedId);
		},
		[browserHost.activeId, panelTabs],
	);

	// Close a tab whose file has unsaved in-app edits only after the user
	// confirms — discarding is destructive and silent. Declining keeps it.
	const closeTabWithGuard = useCallback(
		async (id: string): Promise<void> => {
			const tab = panelTabs.tabs.find(t => t.id === id);
			if (
				tab?.dirty &&
				!(await confirm(t("settings.discardUnsavedChanges"), t("settings.closeAnyway"), { destructive: true }))
			)
				return;
			if (tab?.surface === "files" && tab.target) discardFilePreviewBuffer(cwd, tab.target);
			closeTabsFromPanel([id]);
		},
		[closeTabsFromPanel, panelTabs, confirm, cwd],
	);

	// Mirror the inline editor's dirty state onto the file tab: the dot
	// comes from `dirty` on PanelTab, and `setDirty` finds the tab by the
	// path the FilePane registered (target is relative to cwd).
	const onFileDirty = useCallback(
		(path: string, dirty: boolean): void => {
			const id = panelTabId({ surface: "files", target: path });
			panelTabs.setDirty(id, dirty);
		},
		[panelTabs],
	);

	// Double-clicking an italic preview tab performs a non-preview reopen.
	// The upsert rule pins it without changing identity, order, or column.
	const pinTab = useCallback(
		(id: string): void => {
			const tab = panelTabs.tabs.find(t => t.id === id);
			if (!tab?.preview) return;
			panelTabs.open(
				{
					surface: tab.surface,
					target: tab.target,
					label: tab.label,
					dedupeKey: tab.dedupeKey,
					readOnly: tab.readOnly,
					preview: false,
				},
				{ column: tab.column },
			);
		},
		[panelTabs],
	);

	const duplicateTab = useCallback(
		(id: string): void => {
			const sourceIndex = panelTabs.tabs.findIndex(candidate => candidate.id === id);
			const tab = panelTabs.tabs[sourceIndex];
			const managedId = tab ? browserTarget(tab) : null;
			if (tab && managedId) {
				const source = browserTabs.find(candidate => candidate.id === managedId);
				if (!source) return;
				const rightNeighbour = panelTabs.tabs[sourceIndex + 1];
				const duplicateId = openBrowserPanel({ column: tab.column, forceNew: true, url: source.url });
				if (rightNeighbour?.column === tab.column) panelTabs.reorder(`browser::${duplicateId}`, rightNeighbour.id);
				return;
			}
			panelTabs.duplicate(id);
		},
		[openBrowserPanel, panelTabs],
	);

	/** Close a batch (close others / close all): confirm once for every dirty
	 *  tab, then close only the ones the user accepted. Tab strips do not
	 *  name individual files, so each dirty tab gets its own confirm. */
	const closeManyWithGuard = useCallback(
		async (ids: readonly string[]): Promise<void> => {
			const keep = new Set<string>();
			for (const id of ids) {
				const tab = panelTabs.tabs.find(t => t.id === id);
				if (
					tab?.dirty &&
					!(await confirm(t("settings.discardUnsavedChanges"), t("settings.closeAnyway"), { destructive: true }))
				) {
					keep.add(id);
				}
			}
			const closing = ids.filter(id => !keep.has(id));
			for (const id of closing) {
				const tab = panelTabs.tabs.find(t => t.id === id);
				if (tab?.surface === "files" && tab.target) discardFilePreviewBuffer(cwd, tab.target);
			}
			closeTabsFromPanel(closing);
		},
		[closeTabsFromPanel, panelTabs, confirm, cwd],
	);

	const fileWorkspace: FileWorkspaceHost = {
		buffers: filePreviewBuffers,
		openRequest,
		openFile: (path, name, options) =>
			panelTabs.open(
				{
					surface: FILE_WORKSPACE_SURFACE,
					target: path,
					label: name,
					preview: !options.pin && !options.newTab,
				},
				{ forceNew: options.newTab === true },
			),
		setDirty: onFileDirty,
		closeTab: id => void closeTabWithGuard(id),
		onNewSession,
		canNavigateBack: editorHistoryAvailability.back,
		canNavigateForward: editorHistoryAvailability.forward,
		navigateHistory: navigateEditorHistory,
		onEditorNavigate,
		onEditorPositionChange,
	};
	const fileWorkspaceComponent = selectPanelTabComponent(extTabs, FILE_WORKSPACE_SURFACE);
	const browserComponent = selectPanelTabComponent(extTabs, "browser");
	const primarySurfaces = SURFACES.filter(
		surface =>
			surface.group === "primary" &&
			surface.availability === "always" &&
			(surface.id !== FILE_WORKSPACE_SURFACE || fileWorkspaceComponent !== undefined),
	);
	// Session-scoped surfaces (context / trajectory / agents) stay listed while
	// the welcome scene owns the panel — an entry that names what is there beats
	// a silently shorter list — but they are not launchable without a session.
	const sessionMissing = !snap?.sessionId;
	const surfaceLaunchable = (surface: (typeof SURFACES)[number]): boolean =>
		!surfaceRequiresSession(surface) || !sessionMissing;

	// ── Split columns (dsh 0.2.0 two-column parity) ────────────────────
	// One DndContext spans both column strips so a tab drags across
	// columns; the drag-end routes same-column pairs to reorder and
	// cross-column pairs (or column drop zones) to moveToColumn.
	// Desktop drags arm on mousedown; touch keeps the long-press gate so a
	// swipe still scrolls the strip. This drops the pointer activator's
	// isPrimary/button preconditions on Electron.
	const splitSensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
	);
	const tabsCol = (col: PanelColumn): PanelTab[] => tabsInColumn(panelTabs.tabs, col);
	// Column 0's share of the split track. The divider drags it and it is
	// persisted with the rest of the panel layout, so a session reopens with
	// the columns where the user left them.
	const splitRatio = panelSplitRatio(panelTabs);
	const tabForColumn = (col: PanelColumn): PanelTab | null => {
		const colTabs = tabsCol(col);
		const active = panelTabs.columnActive[col];
		return colTabs.find(t => t.id === active) ?? colTabs[colTabs.length - 1] ?? null;
	};
	const onSplitDragEnd = (e: DragEndEvent): void => {
		const active = String(e.active.id);
		const over = e.over ? String(e.over.id) : null;
		if (!over || active === over) return;
		if (over === "panel-col-0" || over === "panel-col-1") {
			panelTabs.moveToColumn(active, over === "panel-col-0" ? 0 : 1);
			return;
		}
		const overTab = panelTabs.tabs.find(tb => tb.id === over);
		const activeTab = panelTabs.tabs.find(tb => tb.id === active);
		if (!overTab || !activeTab) return;
		if (overTab.column === activeTab.column) {
			panelTabs.reorder(active, over);
			return;
		}
		// Cross-column chip drop: move first, then reorder inside the now-shared
		// column so the tab lands where the pointer released instead of at the
		// column's end. Both updaters are functional, so they compose in order.
		panelTabs.moveToColumn(active, overTab.column);
		panelTabs.reorder(active, over);
	};

	// Drop resolution (lib/panel-tab-dnd.ts): containment picks the target, a
	// same-column zone falls back to that column's nearest chip (releasing
	// between chips reorders), and just-off-strip drops still land on the
	// nearest chip. Keeps one stable verdict per pointer position, so the
	// strips no longer animate every frame while a chip hovers a boundary.
	const panelDropCollision: CollisionDetection = useCallback(
		args => {
			// PointerSensor normally supplies coordinates; the first collision
			// pass and keyboard activation do not. A null pointer used to return
			// no collisions at all, so the drop ended with `over: null` and the
			// tab snapped back. Fall back to the dragged chip's centre.
			const pointer = panelDropPointer(args.pointerCoordinates, args.collisionRect);
			const rects = new Map<string, ClientRect>();
			for (const container of args.droppableContainers) {
				const rect = args.droppableRects.get(container.id);
				if (rect) rects.set(String(container.id), rect);
			}
			const tabs = panelTabs.tabs.map(tab => ({ id: tab.id, column: tab.column }));
			const zones: PanelDropZone[] = panelTabs.split
				? [
						{ id: "panel-col-0", column: 0 },
						{ id: "panel-col-1", column: 1 },
					]
				: [{ id: "panel-split-zone", column: 0, kind: "split" }];
			const hit = resolvePanelDrop({
				activeId: String(args.active.id),
				pointer,
				rects,
				tabs,
				zones,
			});
			return hit ? [{ id: hit.id }] : [];
		},
		[panelTabs.tabs, panelTabs.split],
	);

	// 「+」surface picker (dsh strip add-control parity): every primary
	// surface is launchable from the strip itself, into the clicked column.
	const [addMenu, setAddMenu] = useState<{ column: PanelColumn; x: number; y: number } | null>(null);

	// Single-column drag-to-split (dsh dock-zone parity, user 2026-09-29):
	//  dragging a tab onto the body's right half splits the panel and seats
	//  the tab in column 1 — no pre-clicked split toggle needed. Same
	//  containment collision as the split strips: stable verdict, no flicker.
	const [stripDragId, setStripDragId] = useState<string | null>(null);
	const onStripDragEnd = (e: DragEndEvent): void => {
		const active = String(e.active.id);
		const over = e.over ? String(e.over.id) : null;
		setStripDragId(null);
		if (over === "panel-split-zone") {
			panelTabs.setSplit(true);
			panelTabs.moveToColumn(active, 1);
			return;
		}
		if (!over || active === over) return;
		panelTabs.reorder(active, over);
	};

	/** Panel body for ONE column's displayed tab. Both split columns and
	 *  the single-column layout render through here, so a surface looks
	 *  identical in either shape. The browser singleton renders only in
	 *  the globally-focused column (the page host projects onto one slot). */
	const renderPanelBody = (bodyView: string | null, bodyTab: PanelTab | null): ReactNode =>
		bodyView === "browser" ? (
			bodyTab !== null && bodyTab.id !== panelTabs.activeId ? (
				<button
					type="button"
					className="gui-pane-tab-empty gui-pane-tab-empty--clickable"
					onClick={() => activateTab(bodyTab.id)}
				>
					<span className="gui-pane-tab-empty-icon">
						<Icon name="window" />
					</span>
					<p className="gui-pane-tab-empty-title">{t("settings.browserShownOtherColumn")}</p>
					<p className="gui-pane-tab-empty-hint">{t("settings.clickFocusBrowserTab")}</p>
				</button>
			) : /* Browser pane renders OUTSIDE the feather-scroll container:
			 * the page is a DOM <webview> owned by the always-mounted
			 * ManagedBrowserHost, which mirrors THIS pane's slot rect
			 * (fixed overlay). The slot must sit in a plain flex column —
			 * a padded/scrollable wrapper breaks the height chain the
			 * ResizeObserver measures. See docs/review/0.5.0-sidepanel-
			 * browser-rendering.md §1.2 (A1: the old "native WebContentsView
			 * projection" motive is gone; the host stays for the maximized
			 * layering and blank start-page glass stacking). */
			browserComponent ? (
				<SlotComponentMount
					item={browserComponent}
					rpc={rpc}
					sessionId={snap?.sessionId}
					cwd={cwd}
					panelTab={bodyTab ?? undefined}
					browser={{ open, openRequest: browserOpenRequest, onTakeover: onBrowserTakeover }}
				/>
			) : isElectron() ? null : (
				<LegacyBrowserPane rpc={rpc} />
			)
		) : bodyView === "git" || bodyView === "diff" || bodyView === "pr" ? (
			<GitPanel rpc={rpc} cwd={cwd} sessionId={snap?.sessionId ?? null} />
		) : bodyView === "files" && cwd ? (
			/* FilePane is a full-height flex column whose file list owns the
			 * scroll. Wrapping it in the feather-scroll (padding + overflow-y)
			 * made the 100%-height child overflow that padded box, so the tab
			 * painted a second scrollbar beside the list's own. The wrapper
			 * keeps the shared gutter but never scrolls. */
			<div className="flex min-h-0 flex-1 flex-col px-2.5 pb-3 pt-1.5">
				{fileWorkspaceComponent ? (
					<SlotComponentMount
						item={fileWorkspaceComponent}
						rpc={rpc}
						sessionId={snap?.sessionId}
						cwd={cwd}
						panelTab={bodyTab ?? undefined}
						fileWorkspace={fileWorkspace}
					/>
				) : (
					<div className="gui-pane-tab-empty">
						<span className="gui-pane-tab-empty-icon">
							<Icon name="folder" />
						</span>
						<p className="gui-pane-tab-empty-title">{t("tools.bundlePluginDisabled")}</p>
					</div>
				)}
			</div>
		) : bodyView === "jobs" ? (
			/* Background jobs (composer chip target): JobPane owns its own
			 * polling and output tail; this wrapper only supplies the scroll
			 * box the panel body expects. */
			snap?.sessionId && rpc ? (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<JobsPane rpc={rpc} sessionId={snap.sessionId} visible={open} />
				</div>
			) : (
				<div className="gui-pane-tab-empty">
					<span className="gui-pane-tab-empty-icon">
						<Icon name="task" />
					</span>
					<p className="gui-pane-tab-empty-title">{t("general.sessionRequired")}</p>
				</div>
			)
		) : bodyView === "trajectory" ? (
			/* Trajectory renders OUTSIDE the feather-scroll (browser/git
			 * parity): its root is a flex-1 column with its own scroll list —
			 * a scroll-wrapper + percentage-height chain lets that nested
			 * list inflate to content height and escape the chat card. */
			<TrajectoryView
				entries={snap?.entries ?? []}
				fullEntries={overviewEntries ?? null}
				pathEntries={pathEntries ?? null}
				fullLoading={overviewLoading}
				fullError={overviewError}
				onLoadOlderHistory={onLoadOlderHistory}
				modelId={snap?.state?.model?.id}
				roundDurations={snap?.roundDurations}
				onJumpToEntry={onJumpToEntry}
				leafId={leafId}
				activePathIds={activePathIds}
				onBranchTo={onBranchTo}
				onSwitchTo={onSwitchTo}
				onForkAt={onForkAt}
			/>
		) : bodyView === "agent" ? (
			/* Subagent session tab: the drawer's live transcript + chat promoted
			 * to a first-class panel tab. Resolved by tab identity (the agent
			 * id), so a roster row and a sub-session row focus ONE tab. The body
			 * is a plain flex column — Transcript owns its scroll. A tab can
			 * outlive its agent (session ended / daemon restarted), so the miss
			 * path is a real state: point at the child session instead. */
			(() => {
				const agentKey = bodyTab?.dedupeKey ?? null;
				const tabTarget = bodyTab?.target ?? null;
				// A live-progress row opens the tab without a child session id, so
				// the address falls back to the agent id; the roster path supplies
				// the real child session id.
				const childSessionId = tabTarget !== null && tabTarget !== agentKey ? tabTarget : null;
				// The roster is the source of truth; a tab can still outlive its
				// row (daemon restarted, row not scanned yet), and the tab itself
				// carries everything the transcript reader needs — agent id,
				// label and child session id — so a missing row is a degraded
				// header, not an empty tab.
				const tabAgent =
					agentKey === null
						? null
						: (rosterAgents.find(agent => agent.id === agentKey) ??
							(bodyTab
								? {
										id: agentKey,
										displayName: bodyTab.label,
										kind: "sub" as const,
										parentId: snap?.sessionId ?? undefined,
										status: "idle" as const,
										hasSessionFile: true,
										createdAt: 0,
										lastActivity: 0,
										...(childSessionId ? { sessionId: childSessionId } : undefined),
									}
								: null));
				if (tabAgent !== null) {
					return (
						<div className="flex min-h-0 flex-1 flex-col">
							<SubagentSessionView
								agent={tabAgent}
								progress={snap?.progress.get(tabAgent.id)?.progress ?? null}
								rpc={rpc}
								host={agentHost}
								sessionId={childSessionId ?? tabAgent.sessionId ?? null}
								parentSessionId={snap?.sessionId ?? null}
								onOpenSession={onOpenSession}
								pollEnabled={open}
							/>
						</div>
					);
				}
				return (
					<div className="gui-pane-tab-empty">
						<span className="gui-pane-tab-empty-icon">
							<Icon name="ai-agent" />
						</span>
						<p className="gui-pane-tab-empty-title">{t("agents.subagentUnavailable")}</p>
						<p className="gui-pane-tab-empty-hint">{t("agents.subagentUnavailableHint")}</p>
						{tabTarget !== null && onOpenSession ? (
							<button type="button" className="gui-btn" onClick={() => onOpenSession(tabTarget)}>
								{t("general.openSubagentSession")}
							</button>
						) : null}
					</div>
				);
			})()
		) : bodyView === "session" ? (
			<SideSessionView
				sessionId={bodyTab?.target ?? null}
				label={bodyTab?.label ?? t("general.sideSession")}
				readOnly={bodyTab?.readOnly === true}
				rpc={rpc}
				activeSessionId={snap?.sessionId ?? null}
				onOpenSession={onOpenSession}
			/>
		) : (
			<FadeScroll className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-1.5">
				{bodyView === "notes" ? (
					<NotesPane rpc={rpc} cwd={cwd} showPlanRequest={planShowRequest} />
				) : bodyView === "artifacts" ? (
					/* Artifacts panel (设计板 W3): artifact.manifest.json
					 * sidecars discovered by the daemon, each card opening
					 * the entry-file viewer (iframe/markdown/source). */
					<ArtifactsPanel rpc={rpc} cwd={cwd} />
				) : bodyView === "agents" ? (
					/* Agents hub (TUI Agent Hub parity): ONE roster for the
					 * session's subagents — live progress rows merged with the
					 * daemon's disk-backed scan, so a finished or daemon-restart
					 * child stays listed. A row opens that agent's session TAB
					 * (agentTabDescriptor carries the child session id, which is
					 * what the tab's "open session" action needs). */
					<>
						{rosterAgents.length === 0 ? (
							<div className="gui-pane-tab-empty">
								<span className="gui-pane-tab-empty-icon">
									<Icon name="ai-agent" />
								</span>
								<p className="gui-pane-tab-empty-title">{t("agents.noSubagents")}</p>
							</div>
						) : (
							<AgentsPanel
								agents={rosterAgents}
								progress={snap?.progress ?? new Map()}
								lifecycle={snap?.lifecycle ?? new Map()}
								selectedId={activeAgentTabKey ?? agentId}
								renderAvatar={(agent, payload, now) => (
									<SubagentAvatar agent={agent} payload={payload} now={now} />
								)}
								onSelect={id => {
									const picked = rosterAgents.find(candidate => candidate.id === id);
									if (picked) panelTabs.open(agentTabDescriptor(picked, picked.sessionId));
								}}
							/>
						)}
						{snap?.sessionId ? (
							<BackgroundJobsSection rpc={rpc} sessionId={snap.sessionId} visible={open} />
						) : null}
					</>
				) : typeof bodyView === "string" && bodyView.startsWith("ext:") ? (
					(() => {
						const item = selectPanelTabComponent(extTabs, bodyView);
						return item ? (
							<FadeScroll className="h-full overflow-y-auto">
								<SlotComponentMount
									item={item}
									rpc={rpc}
									sessionId={snap?.sessionId}
									cwd={cwd}
									panelTab={bodyTab ?? undefined}
								/>
							</FadeScroll>
						) : null;
					})()
				) : !snap?.sessionId ? (
					/* No session: every readout here is session-scoped, so the
					 * tab points at the session list instead of painting zeros. */
					<div className="gui-pane-tab-empty">
						<span className="gui-pane-tab-empty-icon">
							<Icon name="donut-chart" />
						</span>
						<p className="gui-pane-tab-empty-title">{t("settings.selectSession")}</p>
						<p className="gui-pane-tab-empty-hint">{t("settings.contextEmptyHint")}</p>
					</div>
				) : (
					<div className="px-1 py-2">
						{/* Context-window usage: live tokens/capacity bar (product
						 * parity with the header ring — same RPC). */}
						{ctxUsage && (
							<>
								<div className="gui-group-label px-2 pb-1 pt-1">{t("settings.contextWindow2")}</div>
								<div className="px-2">
									<div className="gui-ctx-usage-row">
										<span className="text-[12px] tabular-nums opacity-80">
											{fmtTokens(ctxUsage.tokens)} / {fmtTokens(ctxUsage.contextWindow)}
										</span>
										<span className="text-[12px] tabular-nums opacity-70">
											{Math.round(ctxUsage.percent)}%
										</span>
									</div>
									<div className="gui-ctx-usage-track">
										<div
											className={`gui-ctx-usage-bar${ctxUsage.percent > 90 ? " gui-ctx-usage-bar--hot" : ""}`}
											style={{ width: `${Math.min(100, Math.max(2, ctxUsage.percent))}%` }}
										/>
									</div>
								</div>
							</>
						)}
						{/* Cumulative token usage: per-bucket totals over the
						 * session's assistant messages, plus how much of the
						 * input was served from cache. */}
						{usageTotals.totalTokens > 0 && (
							<>
								<div className="gui-group-label px-2 pb-1 pt-3">{t("sessionInfo.tokens")}</div>
								<div className="grid grid-cols-2 gap-1.5 px-2">
									<div className="gui-ctx-stat">
										<div className="gui-ctx-stat-v tabular-nums">{fmtTokens(usageTotals.input)}</div>
										<div className="gui-ctx-stat-l">{t("sessionInfo.input")}</div>
									</div>
									<div className="gui-ctx-stat">
										<div className="gui-ctx-stat-v tabular-nums">{fmtTokens(usageTotals.output)}</div>
										<div className="gui-ctx-stat-l">{t("sessionInfo.output")}</div>
									</div>
									<div className="gui-ctx-stat">
										<div className="gui-ctx-stat-v tabular-nums">{fmtTokens(usageTotals.cacheRead)}</div>
										<div className="gui-ctx-stat-l">{t("sessionInfo.cacheRead")}</div>
									</div>
									<div className="gui-ctx-stat">
										<div className="gui-ctx-stat-v tabular-nums">{fmtTokens(usageTotals.cacheWrite)}</div>
										<div className="gui-ctx-stat-l">{t("sessionInfo.cacheWrite")}</div>
									</div>
								</div>
								<div className="flex items-baseline justify-between gap-2 px-2 pt-1.5 text-[12px]">
									<span className="text-[var(--color-text-muted)]">{t("sessionInfo.total")}</span>
									<span className="tabular-nums">{fmtTokens(usageTotals.totalTokens)}</span>
								</div>
								{cacheHitRate !== null && (
									<div className="flex items-baseline justify-between gap-2 px-2 pt-1 text-[12px]">
										<span className="text-[var(--color-text-muted)]">{t("sessionInfo.cacheHitRate")}</span>
										<span className="tabular-nums">{cacheHitRate.toFixed(1)}%</span>
									</div>
								)}
							</>
						)}
						{/* Session stats + spend: message count, run time and
						 * what the session has cost so far. */}
						<div className="gui-group-label px-2 pb-1 pt-3">{t("general.stats")}</div>
						<div className="grid grid-cols-2 gap-1.5 px-2">
							<div className="gui-ctx-stat">
								<div className="gui-ctx-stat-v">{messageCount}</div>
								<div className="gui-ctx-stat-l">{t("general.messages")}</div>
							</div>
							<div className="gui-ctx-stat">
								<div className="gui-ctx-stat-v">{runMinutes}</div>
								<div className="gui-ctx-stat-l">{t("general.minutes")}</div>
							</div>
						</div>
						{usageTotals.cost > 0 && (
							<div className="flex items-baseline justify-between gap-2 px-2 pt-1.5 text-[12px]">
								<span className="text-[var(--color-text-muted)]">{t("sessionInfo.spend")}</span>
								<span className="tabular-nums">{fmtCost(usageTotals.cost)}</span>
							</div>
						)}
					</div>
				)}
				{/* Modes v2 右面板 Phase 0-2:扩展贡献区块(panel.right 槽位) —
				 * 挂内容区末尾,随面板滚动。 */}
				<div className="gui-pane-extension px-2 pt-3">
					<SlotComponentHost rpc={rpc} slot={RIGHT_PANEL_SLOT} sessionId={snap?.sessionId} cwd={cwd} />
				</div>
			</FadeScroll>
		);

	const surfaceTabVisual = (tab: PanelTab) => {
		const managedId = browserTarget(tab);
		const managed = managedId ? browserTabs.find(candidate => candidate.id === managedId) : undefined;
		const registry = surfaceById(tab.surface);
		return {
			glyph: managedId ? undefined : surfaceGlyph(tab.surface),
			icon: managedId ? (
				<BrowserPanelTabIcon key={`${managedId}:${managed?.favicon ?? ""}`} favicon={managed?.favicon ?? null} />
			) : registry ? (
				<Icon name={registry.icon as IconName} className="h-3.5 w-3.5" />
			) : undefined,
			agentActive:
				managedId !== null &&
				(browserHost.busyTabIds.includes(managedId) ||
					(browserHost.activity?.status === "dispatched" && browserHost.activity.tabId === managedId)),
		};
	};

	return (
		<>
			{/* Surface-tab context menu (right-click on a panel tab): close /
			 * close others / close all (openchamber tab-menu parity). */}
			{tabMenu !== null && (
				<ContextMenu
					open
					x={tabMenu.x}
					y={tabMenu.y}
					items={(() => {
						const menuIndex = panelTabs.tabs.findIndex(tb => tb.id === tabMenu.id);
						const menuTab = panelTabs.tabs[menuIndex];
						const managedId = menuTab ? browserTarget(menuTab) : null;
						const managed = managedId ? browserTabs.find(candidate => candidate.id === managedId) : null;
						if (menuTab && managed) {
							const hasPage = !managed.blank && managed.url !== "";
							const canExternal = hasPage && /^https?:\/\//i.test(managed.url);
							const closeRight = panelTabs.tabs.filter(
								(tb, index) => index > menuIndex && tb.column === menuTab.column,
							);
							return [
								{
									label: t("tools.browserNewTabRight"),
									icon: "add",
									onSelect: () => openBrowserPanel({ column: menuTab.column, forceNew: true }),
								},
								{
									label: t("tools.browserRefresh"),
									icon: "refresh",
									disabled: !hasPage,
									onSelect: () => {
										selectBrowserTab(managed.id);
										reloadBrowserTab(managed.id);
									},
								},
								{
									label: t("general.duplicateTab"),
									icon: "file-copy-2",
									onSelect: () => duplicateTab(menuTab.id),
								},
								{
									label: t("tools.browserRenameTab"),
									icon: "edit-2",
									onSelect: () => {
										void prompt({
											title: t("tools.browserRenameTabPrompt"),
											defaultValue: managed.customTitle ?? managed.title,
										}).then(name => {
											if (name !== null) renameBrowserTab(managed.id, name);
										});
									},
								},
								{
									label: t("tools.browserCopyUrl"),
									icon: "clipboard",
									divider: true,
									disabled: !hasPage,
									onSelect: () => {
										void copyToClipboard(managed.url).then(ok => {
											if (!ok) {
												window.dispatchEvent(
													new CustomEvent("musepi-gui-toast", {
														detail: t("tools.browserCopyUrlFailed"),
													}),
												);
											}
										});
									},
								},
								{
									label: t("tools.browserOpenSystem"),
									icon: "external-link",
									disabled: !canExternal,
									onSelect: () => void openExternalUrl(managed.url),
								},
								{
									label: managed.muted ? t("tools.browserUnmuteTab") : t("tools.browserMuteTab"),
									icon: "volume-up",
									disabled: !hasPage,
									onSelect: () => setBrowserTabMuted(managed.id, !managed.muted),
								},
								{
									label: t("general.closeTab"),
									icon: "settings.close",
									divider: true,
									onSelect: () => void closeTabWithGuard(menuTab.id),
								},
								{
									label: t("general.closeOtherTabs"),
									icon: "settings.close",
									disabled: panelTabs.tabs.length <= 1,
									onSelect: () =>
										void closeManyWithGuard(
											panelTabs.tabs.filter(tb => tb.id !== menuTab.id).map(tb => tb.id),
										),
								},
								{
									label: t("tools.browserCloseRightTabs"),
									icon: "settings.close",
									disabled: closeRight.length === 0,
									onSelect: () => void closeManyWithGuard(closeRight.map(tb => tb.id)),
								},
							];
						}
						return [
							{
								label: t("general.duplicateTab"),
								icon: "file-copy-2",
								disabled: menuTab?.surface === "context",
								onSelect: () => duplicateTab(tabMenu.id),
							},
							{
								label: t("general.closeTab"),
								icon: "settings.close",
								onSelect: () => void closeTabWithGuard(tabMenu.id),
							},
							{
								label: t("general.closeOtherTabs"),
								icon: "settings.close",
								divider: true,
								disabled: panelTabs.tabs.length <= 1,
								onSelect: () =>
									void closeManyWithGuard(panelTabs.tabs.filter(tb => tb.id !== tabMenu.id).map(tb => tb.id)),
							},
							{
								label: t("general.closeAllTabs"),
								icon: "settings.close",
								disabled: panelTabs.tabs.length === 0,
								onSelect: () => void closeManyWithGuard(panelTabs.tabs.map(tb => tb.id)),
							},
						];
					})()}
					onClose={() => setTabMenu(null)}
				/>
			)}
			{/* 「+」surface picker: the strip's add control opens any primary
			 *  surface as a new tab in the clicked column (dsh canAddTab
			 *  parity). Browser additionally spawns a blank managed tab. */}
			{addMenu !== null && (
				<ContextMenu
					open
					x={addMenu.x}
					y={addMenu.y}
					items={primarySurfaces.map(s => ({
						label: t(s.label as TranslationKey),
						icon: s.icon as IconName,
						disabled: !surfaceLaunchable(s),
						onSelect: () => {
							if (s.id === "browser") {
								openBrowserPanel({ column: addMenu.column, forceNew: true });
								return;
							}
							// Files uses the in-app workspace tree. Selecting another
							// file from that tab creates the file's own tab.
							panelTabs.open({ surface: s.id }, { column: addMenu.column });
						},
					}))}
					onClose={() => setAddMenu(null)}
				/>
			)}
			{/* Maximize: NO scrim (user 2026-09-16 — 最大化不要遮罩，正常缩放卡片尺寸即可).
			 * The panel floats exactly over the measured chat-column card; the
			 * surrounding gutters stay live and the chat keeps working behind it. */}
			{/* Gesture shield: owns the move/up half of an edge drag while the
			 * pointer is held (see .gui-drag-shield). Pointer capture alone does
			 * not retarget moves that leave the handle for the page's guest, and
			 * that is what killed these drags. */}
			{gestureShield &&
				createPortal(
					<div
						className="gui-drag-shield"
						onPointerMove={resizeDrag.onPointerMove}
						onPointerUp={resizeDrag.onPointerUp}
						onPointerCancel={resizeDrag.onPointerCancel}
						aria-hidden
					/>,
					document.getElementById("transcript.root") ?? document.body,
				)}
			{/* Always mounted. Inserting a full-screen fixed layer in the very
			 * render that onDragStart produced rebuilt the DOM while dnd-kit was
			 * measuring droppables; pointer-events alone now arms the gesture. */}
			{createPortal(
				<div
					className="gui-drag-shield gui-panel-drag-shield"
					data-active={stripDragId !== null ? "" : undefined}
					aria-hidden
				/>,
				document.getElementById("transcript.root") ?? document.body,
			)}
			<aside ref={panelRef} className={panelClass} style={maximized ? undefined : { width }}>
				{/* Left-edge drag handle for width: pointer capture on the 4px
				 * strip plus the gesture shield (the page guest swallows captured
				 * moves that leave the strip). */}
				<div className="gui-pane-resize-x" {...(resizeHandleHandlers ?? {})} aria-hidden />
				<div className="flex h-full min-h-0 w-full flex-col">
					{panelTabs.split ? (
						<DndContext
							sensors={splitSensors}
							collisionDetection={panelDropCollision}
							modifiers={[restrictToXAxis]}
							onDragStart={e => setStripDragId(String(e.active.id))}
							onDragEnd={e => {
								setStripDragId(null);
								onSplitDragEnd(e);
							}}
							onDragCancel={() => setStripDragId(null)}
						>
							<div className="gui-pane-columns">
								{([0, 1] as const).map(col => {
									const colTabs = tabsCol(col);
									const colTab = tabForColumn(col);
									return (
										<Fragment key={col}>
											{col === 1 && (
												<PanelSplitDivider ratio={splitRatio} onChange={panelTabs.setSplitRatio} />
											)}
											<PanelColumnZone column={col} share={col === 0 ? splitRatio : 1 - splitRatio}>
												{/* dsh TabStrip parity: chips, the add
												 * control and the chrome share ONE row —
												 * no separate control line, the strip
												 * never wraps. Surface-wide chrome
												 * (merge / maximize) rides the second
												 * column's end, the layout's corner. */}
												<PanelHead
													strip={
														<SurfaceTabStripSortable
															tabs={colTabs.map(t => ({
																...surfaceTabVisual(t),
																id: t.id,
																title: t.label,
																dirty: t.dirty,
																preview: t.preview,
															}))}
															activeId={colTab?.id ?? null}
															closeLabel={t("general.closeTab")}
															onActivate={activateTab}
															onClose={closeTabWithGuard}
															onPin={pinTab}
															onReorder={panelTabs.reorder}
															onTabContextMenu={(id, x, y) => setTabMenu({ id, x, y })}
														/>
													}
													tools={
														<>
															<button
																type="button"
																title={t("general.newTab")}
																aria-label={t("general.newTab")}
																className="gui-pane-tool"
																onClick={e => setAddMenu({ column: col, x: e.clientX, y: e.clientY })}
															>
																<Icon name="add" className="h-3.5 w-3.5" />
															</button>
															{col === 1 && (
																<>
																	<button
																		type="button"
																		title={t("settings.mergePanel")}
																		aria-label={t("settings.mergePanel")}
																		className="gui-pane-tool"
																		onClick={() => panelTabs.setSplit(false)}
																	>
																		<MorphIcon
																			icon={panelTabs.split ? PanelLeftIconData : Columns2IconData}
																			size={14}
																			spring="snappy"
																			reducedMotion="user"
																			className="h-3.5 w-3.5"
																		/>
																	</button>
																	<button
																		type="button"
																		title={
																			maximized
																				? t("settings.restorePanel")
																				: t("settings.maximizePanel")
																		}
																		aria-label={
																			maximized
																				? t("settings.restorePanel")
																				: t("settings.maximizePanel")
																		}
																		aria-pressed={maximized}
																		data-panel-maximize
																		className="gui-pane-tool"
																		onPointerDown={event => event.stopPropagation()}
																	>
																		<MorphIcon
																			icon={maximized ? Minimize2IconData : Maximize2IconData}
																			size={14}
																			spring="snappy"
																			reducedMotion="user"
																			className="h-3.5 w-3.5"
																		/>
																	</button>
																</>
															)}
														</>
													}
												/>
												{colTab === null ? (
													<div className="gui-pane-tab-empty">
														<span className="gui-pane-tab-empty-icon">
															<Icon name="layout-column" />
														</span>
														<p className="gui-pane-tab-empty-title">{t("settings.dropTabsHere")}</p>
													</div>
												) : (
													renderPanelBody(colTab.surface, colTab)
												)}
											</PanelColumnZone>
										</Fragment>
									);
								})}
							</div>
						</DndContext>
					) : (
						<DndContext
							sensors={splitSensors}
							collisionDetection={panelDropCollision}
							modifiers={[restrictToXAxis]}
							onDragStart={e => setStripDragId(String(e.active.id))}
							onDragEnd={onStripDragEnd}
							onDragCancel={() => setStripDragId(null)}
						>
							{/* Tab strip row (tab-primary, docs §3.3.2): the strip replaces
							 * the old title bar — the active tab IS the title. The strip
							 * shares ONE DndContext with the body's split drop zone: a tab
							 * dragged onto the right half splits the panel (dsh dock-zone
							 * parity) instead of needing the toggle first. */}
							<PanelHead
								strip={
									panelTabs.tabs.length > 0 ? (
										<SurfaceTabStripSortable
											tabs={panelTabs.tabs.map(t => ({
												...surfaceTabVisual(t),
												preview: t.preview,
												id: t.id,
												title: t.label,
												dirty: t.dirty,
											}))}
											activeId={panelTabs.activeId}
											closeLabel={t("general.closeTab")}
											onActivate={activateTab}
											onClose={closeTabWithGuard}
											onPin={pinTab}
											onReorder={panelTabs.reorder}
											onTabContextMenu={(id, x, y) => setTabMenu({ id, x, y })}
										/>
									) : null
								}
								tools={
									<>
										{/* `+` opens the surface picker (dsh add-control
										 *  parity): every primary surface is launchable
										 *  from the strip. The old browser-only direct
										 *  button read as dead UI on every other surface
										 *  (user 2026-09-22). */}
										<button
											type="button"
											title={t("general.newTab")}
											aria-label={t("general.newTab")}
											className="gui-pane-tool"
											onClick={e => setAddMenu({ column: 0, x: e.clientX, y: e.clientY })}
										>
											<Icon name="add" className="h-3.5 w-3.5" />
										</button>
										<button
											type="button"
											title={t("settings.splitPanel")}
											aria-label={t("settings.splitPanel")}
											className="gui-pane-tool"
											onClick={() => panelTabs.setSplit(true)}
										>
											<MorphIcon
												icon={panelTabs.split ? PanelLeftIconData : Columns2IconData}
												size={14}
												spring="snappy"
												reducedMotion="user"
												className="h-3.5 w-3.5"
											/>
										</button>
										<button
											type="button"
											title={maximized ? t("settings.restorePanel") : t("settings.maximizePanel")}
											aria-label={maximized ? t("settings.restorePanel") : t("settings.maximizePanel")}
											aria-pressed={maximized}
											data-panel-maximize
											className="gui-pane-tool"
											onPointerDown={event => event.stopPropagation()}
										>
											<MorphIcon
												icon={maximized ? Minimize2IconData : Maximize2IconData}
												size={14}
												spring="snappy"
												reducedMotion="user"
												className="h-3.5 w-3.5"
											/>
										</button>
									</>
								}
							/>
							<div className="gui-pane-body-wrap">
								{panelTabs.tabs.length === 0 ? (
									/* Zero tabs → empty-state navigation page (Kimi "从这里开始"
									 * parity): the rail's primary surfaces as launchable entries.
									 * Session-scoped ones stay listed but disabled before a
									 * session exists, with the reason as the hint. */
									<PanelTabsEmptyState
										heading={t("general.startHere")}
										items={primarySurfaces.map(s => {
											const launchable = surfaceLaunchable(s);
											return {
												id: s.id,
												label: t(s.label as TranslationKey),
												icon: <Icon name={s.icon as IconName} className="h-4 w-4" />,
												disabled: !launchable,
												hint: launchable ? undefined : t("general.sessionRequired"),
												onSelect: () => (s.id === "browser" ? openBrowserPanel() : onViewChange(s.id)),
											};
										})}
									/>
								) : (
									renderPanelBody(view, activePanelTab)
								)}
								<PanelSplitZone active={stripDragId !== null} />
							</div>
						</DndContext>
					)}
				</div>
				{/* Subagent trajectory detail (transcript-driven drill-down): an
				 * in-pane layer, always mounted so the slide plays both ways —
				 * the dock wrapper's --open class drives it (MessageTree
				 * parity). It never leaves the pane's stacking context, and
				 * while it is open the view is the agents surface, so the
				 * managed-browser page host has no slot to project onto. */}
				<div className={`gui-agent-dock${dockOpen ? " gui-agent-dock--open" : ""}`}>
					<SubagentPanel
						agent={agent}
						open={dockOpen}
						rpc={rpc}
						progress={agentProgress}
						host={agentHost}
						parentSessionId={snap?.sessionId ?? null}
						onOpenSession={onOpenSession}
						onClose={() => onAgentSelect(null)}
					/>
				</div>
			</aside>
		</>
	);
}

/** One header row shared by the single column and both split columns: the
 *  chips box is the only shrinking part, the add control and window chrome
 *  keep their width. Sharing the row is what keeps the strip at one height
 *  while the panel switches shape. */
function PanelHead({ strip, tools }: { strip: ReactNode; tools: ReactNode }): ReactNode {
	return (
		<div className="gui-pane-head">
			<div className="gui-pane-head-strip">{strip}</div>
			<div className="gui-pane-head-tools">{tools}</div>
		</div>
	);
}

/** Split-column drop zone (dsh two-column parity): the whole column is
 * a droppable so a dragged tab can land on empty space, not just on tabs.
 * `share` is the column's flex-grow share of the split track. */
function PanelColumnZone({
	column,
	share,
	children,
}: {
	column: PanelColumn;
	share?: number;
	children: ReactNode;
}): ReactNode {
	const { setNodeRef, isOver } = useDroppable({ id: `panel-col-${column}` });
	return (
		<div
			ref={setNodeRef}
			style={share === undefined ? undefined : { flexGrow: share }}
			className={`gui-pane-col${column === 1 ? " gui-pane-col--second" : ""}${isOver ? " gui-pane-col--over" : ""}`}
		>
			{children}
		</div>
	);
}

/** Divider between the two split columns (VS Code sash / dsh divider parity):
 *  drag to rebalance, double-click to centre, arrow keys for keyboard users.
 *  The drag runs on the shared pointer-drag primitive and mounts the same
 *  gesture shield as the pane-width handle, so moves that cross the browser
 *  guest keep driving the divider instead of stalling. */
function PanelSplitDivider({ ratio, onChange }: { ratio: number; onChange(next: number): void }): ReactNode {
	const [dragging, setDragging] = useState(false);
	const nodeRef = useRef<HTMLDivElement | null>(null);
	const trackRef = useRef<{ left: number; available: number } | null>(null);

	// The track is measured once per gesture from the divider's own parent:
	// the columns cannot resize it mid-drag, and reading it on every move
	// would thrash layout.
	const measureTrack = (element: HTMLElement | null): void => {
		const host = element?.parentElement?.getBoundingClientRect();
		trackRef.current = host ? { left: host.left, available: host.width - PANEL_SPLIT_DIVIDER_PX } : null;
	};
	const endDrag = (): void => {
		document.body.classList.remove("gui-resizing");
		setDragging(false);
	};
	const drag = usePointerDrag({
		onDragStart: ({ element }) => {
			measureTrack(element);
			// Freezes text selection and the pane's width transition, exactly as
			// the outer width handle does.
			document.body.classList.add("gui-resizing");
			setDragging(true);
		},
		onDragMove: ({ x }) => {
			const track = trackRef.current;
			if (track) onChange(panelSplitRatioAt(x, track));
		},
		onDragEnd: endDrag,
		onTap: endDrag,
	});

	const nudge = (delta: number): void => {
		measureTrack(nodeRef.current);
		const available = trackRef.current?.available ?? 0;
		onChange(nudgePanelSplitRatio(ratio, delta, available));
	};
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const step = event.shiftKey ? 0.1 : 0.02;
		nudge(event.key === "ArrowLeft" ? -step : step);
	};

	return (
		<>
			<div
				ref={nodeRef}
				role="separator"
				aria-orientation="vertical"
				aria-label={t("settings.resizePanelColumns")}
				tabIndex={0}
				className={`gui-pane-split-divider${dragging ? " gui-pane-split-divider--active" : ""}`}
				{...drag}
				onKeyDown={onKeyDown}
				onDoubleClick={() => onChange(0.5)}
			/>
			{dragging &&
				createPortal(
					<div
						className="gui-drag-shield gui-panel-drag-shield"
						onPointerMove={drag.onPointerMove}
						onPointerUp={drag.onPointerUp}
						onPointerCancel={drag.onPointerCancel}
						aria-hidden
					/>,
					document.getElementById("transcript.root") ?? document.body,
				)}
		</>
	);
}

/** Right-half split target (dsh dock-zone parity): while a tab drags in the
 * single-column layout, the body's right half becomes a drop zone that
 * splits the panel and seats the tab in column 1. The droppable stays
 * registered at rest: toggling `disabled` from `onDragStart` rebuilt dnd-kit's
 * droppable set in the very frame it measures rects, leaving every chip with
 * a stale/zero rect and `over: null`. Only visibility is toggled now. */
function PanelSplitZone({ active }: { active: boolean }): ReactNode {
	const { setNodeRef, isOver } = useDroppable({ id: "panel-split-zone" });
	return (
		<div
			ref={setNodeRef}
			aria-hidden={!active}
			className={`gui-pane-split-zone${active ? " gui-pane-split-zone--active" : ""}${isOver ? " gui-pane-split-zone--over" : ""}`}
		>
			{active && (
				<>
					<span className="gui-pane-split-zone-icon">
						<Icon name="layout-column" />
					</span>
					<p className="gui-pane-split-zone-label">{t("settings.dropSplitPanel")}</p>
				</>
			)}
		</div>
	);
}

/** One async job row from `session.jobs` (daemon wire shape). startTime is
 *  an epoch-ms number from the job manager; tolerate strings for robustness.
 *  `questionCount`/`toolCallId`/`outputBytes` come from the async job summary
 *  and are absent on daemons that predate background questions. */
interface JobItem {
	id: string;
	type: string;
	status: string;
	label: string;
	startTime: number | string;
	/** Background `question` job: how many questions await an answer. */
	questionCount?: number;
	toolCallId?: string;
	/** Bytes retained in the job's live-output ring. */
	outputBytes?: number;
}

/** `session.jobs` response: running/recent job lists + delivery counters. */
interface JobsData {
	running: JobItem[];
	recent: JobItem[];
	delivery?: { queued?: number; delivering?: boolean | number; pendingJobIds?: string[] };
}

/** Format a job startTime for the recent list (fallback: raw value). */
function fmtJobTime(ts: number | string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return String(ts);
	return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Background jobs block (agents hub, below the roster): the session's
 *  running and recent async jobs, folded by default. JobsPane polls
 *  `session.jobs` once a second, so the pane mounts only while the block is
 *  open — a folded block must not spend a poll. */
function BackgroundJobsSection({
	rpc,
	sessionId,
	visible,
}: {
	rpc: RpcClient;
	sessionId: string;
	/** Right panel expanded: a folded panel keeps bodies mounted but idle. */
	visible: boolean;
}): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="px-1 pb-2 pt-1">
			<button
				type="button"
				className="gui-pane-action"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
			>
				<Icon name="task" className="h-3.5 w-3.5 flex-shrink-0" />
				<span className="min-w-0 flex-1 truncate text-left">{t("tools.jobs")}</span>
				<Icon
					name="arrow-down-s"
					className={`h-3.5 w-3.5 flex-shrink-0 transition-transform${open ? "" : " -rotate-90"}`}
				/>
			</button>
			{open ? <JobsPane rpc={rpc} sessionId={sessionId} visible={visible} /> : null}
		</div>
	);
}

/** Display window for a selected job's live output (characters). */
export const JOB_OUTPUT_TAIL_LIMIT = 4000;

/** Poll cadence for the jobs list and the selected job's output (ms). */
const JOBS_POLL_INTERVAL_MS = 1000;

/** Settled jobs requested for the「全部」filter. The daemon defaults to 8
 *  (TUI `/jobs` parity), which made the option a quiet lie: 12 finished jobs
 *  in one session showed 8 and the missing ones looked like data loss. 50 is
 *  the retained-history window a panel can actually render (the pane
 *  scrolls); `session.jobs` answers from an in-memory list, so the payload
 *  stays small. */
const JOBS_RECENT_LIMIT = 50;

/** `session.jobOutput` takes a UTF-8 *byte* tail; a character is at most four
 *  bytes, so this window still holds JOB_OUTPUT_TAIL_LIMIT multi-byte
 *  characters before the display trim. */
const JOB_OUTPUT_TAIL_BYTES = JOB_OUTPUT_TAIL_LIMIT * 4;

/** Jobs-pane filter: live jobs only (default) or everything still retained. */
type JobsFilter = "running" | "all";

/** Live-output state for the selected job. Tagged by job id so a poll that
 *  lands after the selection changed cannot paint the previous job's text. */
interface JobOutputState {
	jobId: string | null;
	text: string;
	truncated: boolean;
	unavailable: boolean;
}

const EMPTY_JOB_OUTPUT: JobOutputState = { jobId: null, text: "", truncated: false, unavailable: false };

function clampJobOutput(text: string, limit: number): string {
	return text.length > limit ? text.slice(-limit) : text;
}

/**
 * Append a freshly polled tail to the accumulated output. Each poll returns
 * only the last `limit` characters, so the window slides as the job writes:
 * merge on the longest suffix/prefix overlap instead of concatenating (blind
 * appending duplicates the boundary) or replacing (that drops the start of a
 * buffer that is still growing). A tail that overlaps nothing supersedes the
 * buffer — it is the newest window.
 */
export function mergeJobOutput(current: string, incoming: string, limit = JOB_OUTPUT_TAIL_LIMIT): string {
	if (incoming.length === 0) return current;
	if (current.length === 0 || incoming.startsWith(current)) return clampJobOutput(incoming, limit);
	if (current.startsWith(incoming)) return current;
	for (let k = Math.min(current.length, incoming.length); k > 0; k -= 1) {
		if (current.endsWith(incoming.slice(0, k))) return clampJobOutput(current + incoming.slice(k), limit);
	}
	return clampJobOutput(incoming, limit);
}

/** Question count on a background `question` job (absent on older daemons). */
function jobQuestionCount(job: JobItem): number | null {
	const count = job.questionCount;
	return typeof count === "number" && Number.isFinite(count) ? count : null;
}

/** Jobs HUD (会话任务): running/all filter, per-job cancel, and the selected
 *  job's live output tail. Polls session.jobs every second only while the pane
 *  is visible (`visible` mirrors the right panel's open state — a closed panel
 *  keeps its body mounted, so mounting alone is not visibility). Selecting a
 *  job polls session.jobOutput on the same cadence and accumulates the tail
 *  into one JOB_OUTPUT_TAIL_LIMIT buffer, reading once more after it settles.
 *  A cancel triggers an immediate re-poll (nonce) instead of the next tick. */
export function JobsPane({
	rpc,
	sessionId,
	visible = true,
}: {
	rpc: RpcClient;
	sessionId: string;
	/** False while the right panel is collapsed. */
	visible?: boolean;
}): ReactNode {
	const [data, setData] = useState<JobsData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const [filter, setFilter] = useState<JobsFilter>("running");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [output, setOutput] = useState<JobOutputState>(EMPTY_JOB_OUTPUT);
	useEffect(() => {
		if (!sessionId || !visible) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<JobsData>("session.jobs", { sessionId, recentLimit: JOBS_RECENT_LIMIT })
				.then(d => {
					if (!alive) return;
					setData(d);
					setError(null);
				})
				.catch(err => {
					if (alive) setError(err instanceof Error ? err.message : String(err));
				});
		};
		poll();
		const timer = setInterval(poll, JOBS_POLL_INTERVAL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId, nonce, visible]);

	const running = data?.running ?? [];
	const recent = data?.recent ?? [];
	const selectedJob = running.find(job => job.id === selectedId) ?? recent.find(job => job.id === selectedId) ?? null;
	const selectedRunning = selectedJob?.status === "running";
	// A settled job is read once so its final output replaces the last live
	// tail; the interval only exists while the job keeps writing.
	useEffect(() => {
		if (!sessionId || !selectedId || !visible) return;
		const jobId = selectedId;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<{ output?: string; truncated?: boolean }>("session.jobOutput", {
					sessionId,
					jobId,
					tail: JOB_OUTPUT_TAIL_BYTES,
				})
				.then(res => {
					if (!alive) return;
					setOutput(prev =>
						prev.jobId === jobId
							? {
									...prev,
									text: mergeJobOutput(prev.text, typeof res?.output === "string" ? res.output : ""),
									truncated: res?.truncated === true,
									unavailable: false,
								}
							: {
									jobId,
									text: mergeJobOutput("", typeof res?.output === "string" ? res.output : ""),
									truncated: res?.truncated === true,
									unavailable: false,
								},
					);
				})
				.catch(() => {
					if (!alive) return;
					setOutput(prev =>
						prev.jobId === jobId
							? { ...prev, unavailable: true }
							: { ...EMPTY_JOB_OUTPUT, jobId, unavailable: true },
					);
				});
		};
		poll();
		if (!selectedRunning) {
			return () => {
				alive = false;
			};
		}
		const timer = setInterval(poll, JOBS_POLL_INTERVAL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId, selectedId, selectedRunning, visible]);

	const cancelJob = async (jobId: string): Promise<void> => {
		if (cancelling) return;
		setCancelling(jobId);
		try {
			await rpc.request<{ cancelled: boolean }>("session.jobsCancel", { sessionId, jobId });
			setNonce(n => n + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCancelling(null);
		}
	};

	const delivery = data?.delivery;
	const selectedOutput = output.jobId === selectedId ? output.text : "";
	const selectedTruncated = output.jobId === selectedId && output.truncated;
	const selectedOutputUnavailable = output.jobId === selectedId && output.unavailable;
	const runningIds = new Set(running.map(job => job.id));
	const sections: { key: string; label: string; jobs: JobItem[]; live: boolean }[] =
		filter === "running"
			? [{ key: "running", label: t("tools.jobsRunning"), jobs: running, live: true }]
			: [
					{ key: "running", label: t("tools.jobsRunning"), jobs: running, live: true },
					{
						key: "recent",
						label: t("tools.jobsRecent"),
						jobs: recent.filter(job => !runningIds.has(job.id)),
						live: false,
					},
				];

	const renderJobRow = (job: JobItem, live: boolean): ReactNode => {
		const selected = job.id === selectedId;
		const questionCount = job.type === "question" ? jobQuestionCount(job) : null;
		return (
			<div key={job.id} className="flex items-center gap-1.5 text-[13px]">
				<button
					type="button"
					aria-pressed={selected}
					aria-label={job.label || job.type}
					className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left ${
						selected
							? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
							: "hover:bg-[var(--color-surface-sunken)]"
					}`}
					onClick={() => setSelectedId(prev => (prev === job.id ? null : job.id))}
				>
					{live ? (
						<Icon name="loader-4" className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-[var(--color-accent)]" />
					) : (
						<span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--color-text-faint)]" />
					)}
					<span className="min-w-0 flex-1 truncate">{job.label || job.type}</span>
					{questionCount !== null && (
						<span className="flex-shrink-0 text-[11px] text-[var(--color-text-muted)]">
							{t("tools.questionWithCount", { count: String(questionCount) })}
						</span>
					)}
					{job.type === "question" && live && (
						<span className="flex-shrink-0 rounded-full bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-accent)]">
							{t("tools.jobsWaitingAnswer")}
						</span>
					)}
					{!live && <span className="flex-shrink-0 text-[11px] text-[var(--color-text-muted)]">{job.status}</span>}
					{!live && (
						<span className="flex-shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
							{fmtJobTime(job.startTime)}
						</span>
					)}
				</button>
				{live && (
					<button
						type="button"
						className="gui-pane-action !w-auto flex-shrink-0 px-1.5 text-[12px]"
						title={t("tools.jobsCancel")}
						aria-label={`${t("tools.jobsCancel")}: ${job.label || job.id}`}
						disabled={cancelling !== null}
						onClick={() => void cancelJob(job.id)}
					>
						{cancelling === job.id ? (
							<Icon name="loader-4" className="h-3 w-3 animate-spin" />
						) : (
							<Icon name="close" className="h-3 w-3" />
						)}
						<span>{t("tools.jobsCancel")}</span>
					</button>
				)}
			</div>
		);
	};

	return (
		<div className="px-1 py-2">
			<div className="px-2 pb-2 pt-1">
				<Segmented<JobsFilter>
					className="gui-seg--compact"
					ariaLabel={t("tools.jobs")}
					value={filter}
					options={[
						{ value: "running", label: t("tools.jobsRunning") },
						{ value: "all", label: t("tools.all") },
					]}
					onChange={setFilter}
				/>
			</div>
			{sections.map(section => (
				<div key={section.key}>
					<div className="gui-group-label px-2 pb-1 pt-1">{section.label}</div>
					{section.jobs.length === 0 ? (
						<p className="px-2 py-1 text-[12px] text-[var(--color-text-faint)]">—</p>
					) : (
						<div className="flex flex-col gap-0.5 px-2">
							{section.jobs.map(job => renderJobRow(job, section.live))}
						</div>
					)}
				</div>
			))}
			{selectedId && (
				<div className="mt-2 px-2">
					<div className="gui-group-label pb-1">
						<span className="inline-flex items-center gap-1">
							<Icon name="file-text" className="h-3.5 w-3.5" />
							{t("tools.jobsOutput")}
						</span>
					</div>
					{selectedOutputUnavailable ? (
						<p className="text-[12px] text-[var(--color-text-faint)]">{t("tools.jobsOutputUnavailable")}</p>
					) : selectedOutput.length > 0 ? (
						<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text)]">
							{stripAnsi(replaceTabs(selectedOutput))}
						</pre>
					) : (
						<p className="text-[12px] text-[var(--color-text-faint)]">{t("tools.jobsOutputEmpty")}</p>
					)}
					{selectedTruncated && (
						<p className="pt-1 text-[11px] text-[var(--color-text-faint)]">
							{t("tools.jobsOutputTruncated", { count: String(JOB_OUTPUT_TAIL_LIMIT) })}
						</p>
					)}
				</div>
			)}
			{delivery && (
				<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 text-[12px] text-[var(--color-text-muted)]">
					<span className="inline-flex items-center gap-1">
						<Icon name="inbox-archive" className="h-3.5 w-3.5" />
						{t("tools.jobsQueued")} {delivery.queued ?? 0}
					</span>
					<span className="inline-flex items-center gap-1">
						{t("tools.jobsDelivering")} {delivery.delivering ? "✓" : "—"}
					</span>
					<span className="inline-flex items-center gap-1">
						{t("tools.jobsPending")} {delivery.pendingJobIds?.length ?? 0}
					</span>
				</div>
			)}
			{error && <div className="px-2 pt-2 text-[12px] leading-relaxed text-[var(--color-danger)]">{error}</div>}
		</div>
	);
}

const BROWSER_VIEWPORTS = [
	{ labelKey: "transcript.viewportFit", width: null },
	{ labelKey: "transcript.viewportPhone", width: 393 },
	{ labelKey: "transcript.viewportTablet", width: 768 },
	{ labelKey: "transcript.viewportDesktop", width: 1440 },
] as const;

/** Legacy embedded browser: Electron <webview> (real Chromium, cross-origin
 *  executeJavaScript for the element picker) with an iframe fallback for the
 *  plain-browser build. URL bar, back/forward history, quick ports, viewport
 *  presets and an element-picker that inserts the picked element into the
 *  chat composer via the musepi-gui-insert-text window event. The "Agent 标签页"
 *  strip mirrors the SHARED automation Chromium (the same instance the agent
 *  drives) — click a tab to open its URL here and see a live screenshot. */
interface BrowserTabInfo {
	targetId: string;
	title: string;
	url: string;
}

function LegacyBrowserPane({ rpc }: { rpc: RpcClient }): ReactNode {
	const [url, setUrl] = useState("http://localhost:5173");
	// 横向边缘羽化:Agent 标签页 strip 横向滚动时左右羽化(通用
	// .gui-panel-tabs 类,与 ManagedBrowserPane 的 tab strip 同配方)。
	const agentTabsRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(agentTabsRef);
	const [current, setCurrent] = useState("http://localhost:5173");
	const [history, setHistory] = useState<string[]>(["http://localhost:5173"]);
	const [histIndex, setHistIndex] = useState(0);
	const [loading, setLoading] = useState(true);
	const [picking, setPicking] = useState(false);
	const [viewport, setViewport] = useState<number | null>(null);
	const [agentTabs, setAgentTabs] = useState<BrowserTabInfo[]>([]);
	const [agentShot, setAgentShot] = useState<{ targetId: string; base64: string } | null>(null);
	const webviewRef = useRef<HTMLElement | null>(null);
	const electron = isElectron();

	// Shared-browser tab strip: refresh every 3s while the pane is open
	// (cheap Target.getTargets over the daemon).
	useEffect(() => {
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ tabs?: BrowserTabInfo[] }>("browser.tabs", {})
				.then(res => {
					if (!alive) return;
					const tabs = res?.tabs ?? [];
					setAgentTabs(prev =>
						prev.length === tabs.length && prev.every((t, i) => t.targetId === tabs[i]?.targetId) ? prev : tabs,
					);
				})
				.catch(() => {});
		};
		load();
		const id = setInterval(load, 3000);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [rpc]);

	const pickAgentTab = (tab: BrowserTabInfo): void => {
		go(tab.url);
		void rpc
			.request<{ base64?: string }>("browser.screenshot", { targetId: tab.targetId })
			.then(res => res?.base64 && setAgentShot({ targetId: tab.targetId, base64: res.base64 }))
			.catch(() => {});
	};
	// Webview load-end → clear the loading spinner (addEventListener form:
	// React's webview JSX types don't expose the Electron event props).
	useEffect(() => {
		if (!electron) return;
		const wv = webviewRef.current as unknown as {
			addEventListener?(event: string, fn: () => void): void;
			removeEventListener?(event: string, fn: () => void): void;
		} | null;
		if (!wv?.addEventListener) return;
		const onLoad = (): void => setLoading(false);
		wv.addEventListener("did-finish-load", onLoad);
		return () => wv.removeEventListener?.("did-finish-load", onLoad);
	}, [electron]);
	const normalize = (target: string): string => {
		let u = target.trim();
		if (u && !/^[a-z]+:\/\//i.test(u)) u = `http://${u}`;
		return u;
	};
	const go = (target: string): void => {
		const u = normalize(target);
		if (!u) return;
		setUrl(u);
		setCurrent(u);
		setHistory(h => [...h.slice(0, histIndex + 1), u]);
		setHistIndex(i => i + 1);
	};
	const back = (): void => {
		if (histIndex <= 0) return;
		const idx = histIndex - 1;
		setHistIndex(idx);
		const u = history[idx]!;
		setUrl(u);
		setCurrent(u);
	};
	const forward = (): void => {
		if (histIndex >= history.length - 1) return;
		const idx = histIndex + 1;
		setHistIndex(idx);
		const u = history[idx]!;
		setUrl(u);
		setCurrent(u);
	};
	const refresh = (): void => {
		const u = `${current}${current.includes("?") ? "&" : "?"}_=${Date.now()}`;
		setCurrent(u);
		setHistory(h => [...h.slice(0, histIndex), u]);
	};
	const pickElement = async (): Promise<void> => {
		if (!electron) return;
		const wv = webviewRef.current as unknown as {
			executeJavaScript?(script: string, userGesture: boolean): Promise<unknown>;
		} | null;
		if (!wv?.executeJavaScript) return;
		setPicking(true);
		try {
			const picked = (await wv.executeJavaScript(BROWSER_INSPECT_SCRIPT, true)) as PickedElement | null;
			if (picked?.text) {
				const insertion = `${t("transcript.insertedElement", { tag: picked.tag, text: picked.text.slice(0, 80) })}\n${t("transcript.insertedElementSelector")}: ${picked.selector}`;
				window.dispatchEvent(new CustomEvent("musepi-gui-insert-text", { detail: { text: insertion } }));
			}
		} catch {
			// page not scriptable (about:blank / crashed) — ignore
		} finally {
			setPicking(false);
		}
	};
	const askSelection = async (): Promise<void> => {
		if (!electron) return;
		const wv = webviewRef.current as unknown as {
			executeJavaScript?(script: string, userGesture: boolean): Promise<unknown>;
		} | null;
		if (!wv?.executeJavaScript) return;
		try {
			const picked = (await wv.executeJavaScript(BROWSER_ASK_SELECTION_SCRIPT, true)) as {
				text?: string;
				title?: string;
			} | null;
			if (!picked?.text) return;
			const rect = webviewRef.current?.getBoundingClientRect();
			window.dispatchEvent(
				new CustomEvent("musepi-gui-ask", {
					detail: {
						text: picked.text,
						x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
						y: (rect?.top ?? 0) + Math.min((rect?.height ?? 0) / 2, 200),
						context: picked.title ? `${t("settings.askBrowserSelection")}: ${picked.title}` : undefined,
					},
				}),
			);
		} catch {
			// page not scriptable (about:blank / crashed) — ignore
		}
	};
	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Agent 标签页 strip: live tabs of the shared automation Chromium
			 * (the browser the agent drives). Click → open the URL here +
			 * capture a screenshot thumbnail. */}
			{agentTabs.length > 0 && (
				<div ref={agentTabsRef} className="gui-panel-tabs flex items-center gap-1 overflow-x-auto px-1 pb-1">
					<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">
						{t("tools.agentTabs")}:
					</span>
					{agentTabs.map(tab => (
						<button
							key={tab.targetId}
							type="button"
							className={`gui-pane-tool flex-shrink-0 px-1.5 py-0.5 text-[11px] ${
								agentShot?.targetId === tab.targetId ? "gui-pane-tool--active" : ""
							}`}
							title={tab.url}
							onClick={() => pickAgentTab(tab)}
						>
							<span className="max-w-[110px] truncate">{tab.title}</span>
						</button>
					))}
				</div>
			)}
			{/* Screenshot thumbnail of the picked agent tab. */}
			{agentShot && (
				<div className="relative mx-1 mb-1 overflow-hidden rounded-md border border-[var(--border)]">
					<img
						src={`data:image/jpeg;base64,${agentShot.base64}`}
						alt={t("tools.agentTabPreview")}
						className="block h-24 w-full object-cover object-top opacity-80"
					/>
					<button
						type="button"
						className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded bg-[rgba(0,0,0,0.6)] text-[10px] text-white"
						aria-label={t("settings.close")}
						onClick={() => setAgentShot(null)}
					>
						×
					</button>
				</div>
			)}
			<div className="flex items-center gap-1 px-1 pb-1 pt-1">
				<button
					type="button"
					className="gui-pane-action !w-auto px-1.5"
					aria-label={t("settings.back")}
					title={t("settings.back")}
					disabled={histIndex <= 0}
					onClick={back}
				>
					<Icon name="arrow-left" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-1.5"
					aria-label={t("transcript.forward")}
					title={t("transcript.forward")}
					disabled={histIndex >= history.length - 1}
					onClick={forward}
				>
					<Icon name="arrow-right" className="h-3.5 w-3.5" />
				</button>
				<form
					className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--color-surface-sunken)] px-2 py-1"
					onSubmit={e => {
						e.preventDefault();
						go(url);
					}}
				>
					<Icon name="global" className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]" />
					<input
						className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none"
						value={url}
						spellCheck={false}
						onChange={e => setUrl(e.target.value)}
						placeholder="localhost:5173"
					/>
				</form>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					aria-label={loading ? t("settings.loading2") : t("settings.refresh")}
					title={loading ? t("settings.loading2") : t("settings.refresh")}
					aria-busy={loading ? "true" : undefined}
					onClick={refresh}
				>
					<Icon name="refresh" className={`h-3.5 w-3.5${loading ? " gui-spin" : ""}`} />
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					aria-label={t("transcript.openBrowser")}
					title={t("transcript.openBrowser")}
					onClick={() => void openExternalUrl(current)}
				>
					<Icon name="external-link" className="h-3.5 w-3.5" />
				</button>
				{electron && (
					<button
						type="button"
						className={`gui-pane-action !w-auto px-2${picking ? " gui-view-opt--active" : ""}`}
						aria-label={picking ? t("transcript.stopPickingElement") : t("transcript.pickElement")}
						title={picking ? t("transcript.stopPickingElement") : t("transcript.pickElement")}
						onClick={() => void pickElement()}
					>
						<Icon name="cursor" className="h-3.5 w-3.5" />
					</button>
				)}
				{electron && (
					<button
						type="button"
						className="gui-pane-action !w-auto px-2"
						aria-label={t("settings.askAboutPageSelection")}
						title={t("settings.askAboutPageSelection")}
						onClick={() => void askSelection()}
					>
						<Icon name="sparkling" className="h-3.5 w-3.5" />
					</button>
				)}
				{/* Viewport presets (手机/平板/桌面/自适应): the browser pane is
				 * used for responsive checks — fixed widths wrap the webview. */}
				<div className="flex items-center gap-0.5 rounded-md border border-[var(--border)] p-0.5">
					{BROWSER_VIEWPORTS.map(v => (
						<button
							key={v.labelKey}
							type="button"
							className={`gui-pane-action !w-auto px-1.5 text-[10.5px]${
								viewport === v.width ? " gui-view-opt--active" : ""
							}`}
							aria-label={t(v.labelKey)}
							title={t(v.labelKey)}
							onClick={() => setViewport(v.width)}
						>
							{t(v.labelKey)}
						</button>
					))}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-white">
				<div
					className="mx-auto h-full min-h-full transition-[width] duration-150"
					style={viewport ? { width: viewport } : { width: "100%" }}
				>
					{electron ? (
						<webview
							ref={webviewRef}
							src={current}
							partition="persist:musepi-browser"
							allowpopups
							webpreferences="contextIsolation=yes, sandbox=yes"
							className="h-full w-full"
							style={{ display: "flex" }}
							{...({
								onDidStartLoading: () => setLoading(true),
								onDidStopLoading: () => setLoading(false),
							} as Record<string, unknown>)}
						/>
					) : (
						<iframe
							key={current}
							src={current}
							className="h-full w-full border-0"
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
							title={t("settings.browser")}
							onLoad={() => setLoading(false)}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
