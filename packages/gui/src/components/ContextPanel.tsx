import { AgentsPanel, latestWidgetFromEntries, type TranslationKey, t, WidgetCard } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isElectron, openExternalUrl } from "../lib/electron";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionState } from "../lib/session-store";
import { RIGHT_PANEL_SLOT, SlotComponentHost, SlotComponentMount } from "../lib/slot-host";
import { surfaceById } from "../lib/surfaces/registry";
import { Icon } from "../vendor/oc-icons";
import { AgentControls } from "./AgentControls";
import { FadeScroll } from "./FadeScroll";
import { FilePane } from "./FilePane";
import { GitPanel } from "./git-panel";
import { ManagedBrowserPane } from "./ManagedBrowserPane";
import { NotesPane } from "./notes-pane";
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
	extTabs = [],
	view,
	onViewChange,
	leafId,
	activePathIds,
	onBranchTo,
	onForkAt,
	onJumpToEntry,
}: {
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
	openRequest?: { path: string; nonce: number } | null;
	/** External browser reveal (chat link click / agent browser.open):
	 *  switches to the browser tool and navigates the active tab. */
	browserOpenRequest?: { url: string; nonce: number } | null;
	/** Extension panel-tab slots (panel.tab.*); nav items live in the
	 *  RightRail — the panel only renders their content. */
	extTabs?: import("../lib/slot-host").SlotComponent[];
	/** Active view — controlled from ChatView; the RightRail is the single
	 *  navigation axis (nav unification), so this covers session tabs
	 *  (context/files/…), tool panes (git/browser/…) and ext:* slots. */
	view: string | null;
	onViewChange(view: string | null): void;
	/** Jump the transcript to an entry id (trajectory rows; provided by
	 *  ChatView — absent = trajectory rows render without jump action). */
	onJumpToEntry?(entryId: string): void;
	/** Layer-2 分支树(轨迹 Tree 模式):当前叶 + 活动路径 + 分支/fork 动作。 */
	leafId?: string | null;
	activePathIds?: ReadonlySet<string>;
	onBranchTo?(id: string): void;
	onForkAt?(id: string): void;
}): ReactNode {
	const cwd = snap?.state?.cwd ?? "";
	// Live mode chips (daemon injects goalMode/planMode into the snapshot).
	const modes = snap?.state as { goalMode?: { enabled?: boolean; objective?: string }; planMode?: boolean } | null;
	// Session stats: message count + wall-clock run time.
	const messageCount = (snap?.entries ?? []).filter(e => e.type === "message").length;
	const firstTs = (snap?.entries ?? []).find(e => typeof e.timestamp === "string")?.timestamp;
	const runMinutes =
		typeof firstTs === "string" ? Math.max(0, Math.round((Date.now() - new Date(firstTs).getTime()) / 60000)) : 0;

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
	// Selected subagent (TUI Agent Hub parity): click a roster row to open
	// its kill/revive/chat controls beneath the panel.
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const selectedAgent =
		selectedAgentId !== null ? ((snap?.agents ?? []).find(a => a.id === selectedAgentId) ?? null) : null;
	// Session-hygiene actions (会话维护): shake / fresh / reset-context —
	// each daemon RPC returns counts rendered into a shared status line.
	// The clear action asks for confirmation first (destructive).
	const { confirm } = useConfirm();
	const [maintenanceBusy, setMaintenanceBusy] = useState<"shake" | "fresh" | "clear" | null>(null);
	const [maintenanceStatus, setMaintenanceStatus] = useState<string | null>(null);
	const runMaintenance = async (op: "shake" | "fresh" | "clear"): Promise<void> => {
		if (!rpc || !snap?.sessionId || maintenanceBusy) return;
		if (op === "clear" && !(await confirm(t("confirm clear context")))) return;
		setMaintenanceBusy(op);
		setMaintenanceStatus(null);
		try {
			if (op === "shake") {
				const r = await rpc.request<{
					toolResultsDropped: number;
					blocksDropped: number;
					imagesDropped: number;
					tokensFreed: number;
				}>("session.shake", { sessionId: snap.sessionId, mode: "elide" });
				setMaintenanceStatus(
					t("shake result {dropped} blocks {tokens} tokens", {
						dropped: r.toolResultsDropped,
						tokens: r.tokensFreed,
					}),
				);
			} else if (op === "fresh") {
				const r = await rpc.request<{ closedProviderSessions: number }>("session.fresh", {
					sessionId: snap.sessionId,
				});
				setMaintenanceStatus(t("fresh result {closed} sessions", { closed: r.closedProviderSessions }));
			} else {
				const r = await rpc.request<{ droppedCount: number }>("session.resetContext", {
					sessionId: snap.sessionId,
				});
				setMaintenanceStatus(t("clear result {dropped} messages", { dropped: r.droppedCount }));
			}
		} catch (err) {
			setMaintenanceStatus(err instanceof Error ? err.message : String(err));
		} finally {
			setMaintenanceBusy(null);
		}
	};
	// Relay external reveal requests into the FilePane preview.
	useEffect(() => {
		if (!openRequest) return;
		onViewChange("files");
	}, [openRequest]);
	// Relay external browser reveals: switch to the browser view (the rail
	// selects it; ManagedBrowserPane navigates on the nonce).
	useEffect(() => {
		if (!browserOpenRequest) return;
		onViewChange("browser");
	}, [browserOpenRequest, onViewChange]);
	// Managed browser (Proma 吸收): when the agent opens a tab in the in-app
	// browser (browser.gui), surface the browser tool so the user sees the
	// agent's work without hunting for the panel. Skipped while the panel is
	// maximized (the mirror ref is declared here, wired to state below) — an
	// agent browsing in the background must not yank the maximized view.
	const agentBrowserTabRef = useRef<string | null>(null);
	const maximizedRef = useRef(false);
	useEffect(() => {
		const api = window.electronAPI;
		if (!api || typeof api.onManagedBrowserState !== "function") return;
		return api.onManagedBrowserState(next => {
			if (maximizedRef.current) return;
			if (next.agentActivity === true && next.activeTabId && agentBrowserTabRef.current !== next.activeTabId) {
				agentBrowserTabRef.current = next.activeTabId;
				onViewChange("browser");
			}
		});
	}, []);
	// Resizable right-pane width (openchamber parity): drag the left edge;
	// persisted per run.
	// Width range 260–1200 (openchamber ContextPanel 380–1400, adapted to the
	// desktop surface): file preview takeover and the browser need room; 260
	// keeps a minimal notes/context view usable. 1200 = code previews at
	// readable width.
	const [width, setWidth] = useState(() => {
		try {
			const v = Number.parseInt(localStorage.getItem("musepi-gui-right-width") ?? "", 10);
			return Number.isFinite(v) && v >= 260 && v <= 1200 ? v : 340;
		} catch {
			return 340;
		}
	});
	// Maximize (openchamber fullscreen-surface / proma quick-window parity):
	// the panel floats over the chat column at near-full width/height; toggling
	// off returns to the persisted width. Width-drag is disabled while maximized.
	const [maximized, setMaximized] = useState(false);
	maximizedRef.current = maximized;
	const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
	/** Snap points for right-panel width (px). Drag snaps on release. */
	const SNAP_POINTS = [300, 480, 800];
	const snapWidth = (w: number): number => {
		let best = SNAP_POINTS[0];
		for (const sp of SNAP_POINTS) {
			if (Math.abs(sp - w) < Math.abs(best - w)) best = sp;
		}
		return best;
	};
	const onResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
		resizeRef.current = { startX: e.clientX, startW: width };
		const move = (ev: PointerEvent): void => {
			const s = resizeRef.current;
			if (!s) return;
			const next = Math.min(1200, Math.max(260, s.startW + (s.startX - ev.clientX)));
			setWidth(next);
		};
		const up = (): void => {
			resizeRef.current = null;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			const snapped = snapWidth(width);
			setWidth(snapped);
			try {
				localStorage.setItem("musepi-gui-right-width", String(snapped));
			} catch {
				// storage unavailable
			}
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	const panelClass = `gui-pane-right gui-pane-right--inner${open ? "" : " gui-pane-right--inner--closed"}${maximized ? " gui-pane-right--maximized" : ""}${className ? ` ${className}` : ""}`;
	// Header chrome title (nav unification): the rail owns navigation;
	// the header labels the active view.
	const headerTitle = useMemo(() => {
		if (!view) return t("context");
		const ext = view.startsWith("ext:") ? extTabs.find(x => `ext:${x.slot}` === view) : undefined;
		if (ext) return ext.label ?? ext.slot;
		return t((surfaceById(view)?.label ?? "context") as TranslationKey);
	}, [view, extTabs]);

	return (
		<>
			{/* Maximize modal scrim (user: 最大化没有遮罩、前后内容重叠): dims the
			 * chat column behind the floated panel — the fixed transcript float
			 * scrollbar and hover chrome must not read as part of the panel.
			 * Click-through restores the docked width. Starts below the 48px
			 * header so the title bar stays live. */}
			{maximized && open && (
				<div className="gui-pane-maximize-backdrop" onClick={() => setMaximized(false)} aria-hidden />
			)}
			<aside className={panelClass} style={{ width: maximized ? "min(1280px, calc(100vw - 80px))" : width }}>
				{/* Left-edge drag handle for width (pointer capture on the 4px
				 * strip; cursor col-resize over it). */}
				<div className="gui-pane-resize-x" onPointerDown={maximized ? undefined : onResizeStart} aria-hidden />
				<div className="flex h-full min-h-0 w-full flex-col">
					{/* View-local chrome (nav unification): the RightRail owns
					 * navigation; the header shows the current view's title plus the
					 * panel-level maximize toggle. */}
					<div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-[var(--border)] px-3">
						<span className="gui-pane-title truncate text-[12px] font-medium text-[var(--color-text-muted)]">
							{headerTitle}
						</span>
						<div className="ml-auto flex items-center gap-0.5">
							<button
								type="button"
								title={maximized ? t("restore panel") : t("maximize panel")}
								aria-label={maximized ? t("restore panel") : t("maximize panel")}
								className="gui-pane-tool"
								onClick={() => setMaximized(v => !v)}
							>
								<Icon name={maximized ? "fullscreen-exit" : "fullscreen"} className="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
					{view === "browser" ? (
						/* Browser pane renders OUTSIDE the feather-scroll container:
						 * the native WebContentsView projects the slot's exact CSS
						 * rect — a padded/scrollable wrapper breaks the height chain
						 * and clips the projection. */
						<BrowserPane rpc={rpc} browserOpenRequest={browserOpenRequest} />
					) : view === "git" || view === "diff" || view === "pr" ? (
						<GitPanel rpc={rpc} cwd={cwd} />
					) : view === "trajectory" ? (
						/* Trajectory renders OUTSIDE the feather-scroll (browser/git
						 * parity): its root is a flex-1 column with its own scroll list —
						 * a scroll-wrapper + percentage-height chain lets that nested
						 * list inflate to content height and escape the chat card. */
						<TrajectoryView
							entries={snap?.entries ?? []}
							modelId={snap?.state?.model?.id}
							roundDurations={snap?.roundDurations}
							onJumpToEntry={onJumpToEntry}
							leafId={leafId}
							activePathIds={activePathIds}
							onBranchTo={onBranchTo}
							onForkAt={onForkAt}
						/>
					) : (
						<FadeScroll className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-1.5">
							{view === "notes" ? (
								<NotesPane rpc={rpc} cwd={cwd} />
							) : view === "files" && cwd ? (
								<FilePane rpc={rpc} cwd={cwd} openRequest={openRequest} />
							) : view === "widget" ? (
								<WidgetSidebarTab entries={snap?.entries ?? []} />
							) : view === "jobs" ? (
								snap?.sessionId ? (
									<JobsPane rpc={rpc} sessionId={snap.sessionId} />
								) : (
									<div className="gui-pane-tab-empty">
										<span className="gui-pane-tab-empty-icon">
											<Icon name="inbox-archive" />
										</span>
										<p className="gui-pane-tab-empty-title">{t("select a session")}</p>
										<p className="gui-pane-tab-empty-hint">{t("jobs empty hint")}</p>
									</div>
								)
							) : typeof view === "string" && view.startsWith("ext:") ? (
								(() => {
									const item = extTabs.find(x => `ext:${x.slot}` === view);
									return item ? (
										<FadeScroll className="h-full overflow-y-auto">
											<SlotComponentMount item={item} rpc={rpc} sessionId={snap?.sessionId} cwd={cwd} />
										</FadeScroll>
									) : null;
								})()
							) : (
								<div className="px-1 py-2">
									<div className="gui-group-label px-2 pb-1 pt-1">{t("session")}</div>
									<div className="flex flex-col gap-1 px-2 text-[13px]">
										<div className="flex items-center gap-2 text-[var(--color-text-muted)]">
											<Icon name="folder" className="h-3.5 w-3.5 flex-shrink-0" />
											<span className="truncate">{cwd || t("no folder")}</span>
										</div>
										{snap?.state?.model?.id && (
											<div className="flex items-center gap-2 text-[var(--color-text-muted)]">
												<Icon name="ai-agent" className="h-3.5 w-3.5 flex-shrink-0" />
												<span className="truncate">{snap.state.model.id}</span>
											</div>
										)}
										{modes && (
											<div className="flex items-center gap-2 text-[var(--color-text-muted)]">
												<Icon name="target" className="h-3.5 w-3.5 flex-shrink-0" />
												<span className="truncate">
													{modes.goalMode?.enabled === true
														? `${t("goal mode")}: ${modes.goalMode.objective ?? ""}`
														: modes.planMode === true
															? t("plan mode")
															: t("default mode")}
												</span>
											</div>
										)}
									</div>
									{/* Session stats (openchamber context-drawer parity): message
									 * count and run time at a glance. */}
									<div className="gui-group-label px-2 pb-1 pt-3">{t("stats")}</div>
									<div className="grid grid-cols-2 gap-1.5 px-2">
										<div className="gui-ctx-stat">
											<div className="gui-ctx-stat-v">{messageCount}</div>
											<div className="gui-ctx-stat-l">{t("messages")}</div>
										</div>
										<div className="gui-ctx-stat">
											<div className="gui-ctx-stat-v">{runMinutes}</div>
											<div className="gui-ctx-stat-l">{t("minutes")}</div>
										</div>
									</div>
									{/* Context-window usage: live tokens/capacity bar (product
									 * parity with the header ring — same RPC). */}
									{ctxUsage && (
										<>
											<div className="gui-group-label px-2 pb-1 pt-3">{t("context window")}</div>
											<div className="px-2">
												<div className="gui-ctx-usage-row">
													<span className="text-[12px] tabular-nums opacity-80">
														{fmtTokens(ctxUsage.tokens)} / {fmtTokens(ctxUsage.contextWindow)}
														{ctxUsage.model ? ` · ${ctxUsage.model}` : ""}
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
									{/* Reusable context quick actions: copy the workspace path. */}
									<div className="mt-2 flex flex-col gap-0.5 px-2">
										<button
											type="button"
											className="gui-pane-action"
											onClick={() => {
												if (cwd) void navigator.clipboard.writeText(cwd).catch(() => {});
											}}
										>
											<Icon name="clipboard" className="h-3.5 w-3.5" />
											<span>{t("copy workspace path")}</span>
										</button>
									</div>
									{/* Swarm visual parity (TUI subagent HUD): live agent rows —
									 * status dot, activity line, token/cost meta — fed from
									 * the session stream (agent-progress/lifecycle). Click a
									 * row to open its kill/revive/chat controls. */}
									<div className="gui-group-label px-2 pb-1 pt-3">{t("agents")}</div>
									<div className="px-2">
										<AgentsPanel
											agents={snap?.agents ?? []}
											progress={snap?.progress ?? new Map()}
											lifecycle={snap?.lifecycle ?? new Map()}
											selectedId={selectedAgentId}
											onSelect={setSelectedAgentId}
										/>
										{selectedAgent && (
											<AgentControls
												agent={selectedAgent}
												rpc={rpc}
												onClose={() => setSelectedAgentId(null)}
											/>
										)}
									</div>
									{/* Session hygiene (会话维护): shake context / reset
									 * provider stream / clear session context — each RPC
									 * reports counts into the status line below. */}
									<div className="gui-group-label px-2 pb-1 pt-3">{t("session maintenance")}</div>
									<div className="flex flex-col gap-0.5 px-2">
										<button
											type="button"
											className="gui-pane-action"
											disabled={!snap?.sessionId || maintenanceBusy !== null}
											onClick={() => void runMaintenance("shake")}
										>
											<Icon
												name={maintenanceBusy === "shake" ? "loader-4" : "scissors"}
												className={`h-3.5 w-3.5${maintenanceBusy === "shake" ? " animate-spin" : ""}`}
											/>
											<span>{t("shake context")}</span>
										</button>
										<button
											type="button"
											className="gui-pane-action"
											disabled={!snap?.sessionId || maintenanceBusy !== null}
											onClick={() => void runMaintenance("fresh")}
										>
											<Icon
												name={maintenanceBusy === "fresh" ? "loader-4" : "restart"}
												className={`h-3.5 w-3.5${maintenanceBusy === "fresh" ? " animate-spin" : ""}`}
											/>
											<span>{t("fresh provider")}</span>
										</button>
										<button
											type="button"
											className="gui-pane-action"
											disabled={!snap?.sessionId || maintenanceBusy !== null}
											onClick={() => void runMaintenance("clear")}
										>
											<Icon
												name={maintenanceBusy === "clear" ? "loader-4" : "delete-bin"}
												className={`h-3.5 w-3.5${maintenanceBusy === "clear" ? " animate-spin" : ""}`}
											/>
											<span>{t("clear session context")}</span>
										</button>
									</div>
									{maintenanceStatus && (
										<p className="px-2 pt-1.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
											{maintenanceStatus}
										</p>
									)}
								</div>
							)}
							{/* Modes v2 右面板 Phase 0-2:扩展贡献区块(panel.right 槽位) —
							 * 挂内容区末尾,随面板滚动。 */}
							<div className="gui-pane-extension px-2 pt-3">
								<SlotComponentHost rpc={rpc} slot={RIGHT_PANEL_SLOT} sessionId={snap?.sessionId} cwd={cwd} />
							</div>
						</FadeScroll>
					)}
				</div>
			</aside>
		</>
	);
}

/** Persistent widget preview tab (常驻标签页): mirrors the latest widget
 *  the conversation rendered. The last successful widget tool result wins;
 *  the card stays until a newer widget replaces it. */
function WidgetSidebarTab({ entries }: { entries: readonly unknown[] }): ReactNode {
	const payload = latestWidgetFromEntries(entries);
	if (!payload) {
		return (
			<div className="gui-widget-tab-empty">
				<Icon name="layout-column" className="h-5 w-5" />
				<p>{t("widget preview empty")}</p>
			</div>
		);
	}
	return (
		<div className="gui-widget-tab">
			<WidgetCard payload={payload} />
		</div>
	);
}

/** One async job row from `session.jobs` (daemon wire shape). startTime is
 *  an epoch-ms number from the job manager; tolerate strings for robustness. */
interface JobItem {
	id: string;
	type: string;
	status: string;
	label: string;
	startTime: number | string;
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

/** Jobs HUD (会话任务): running jobs with per-job cancel, recent jobs with
 *  status + start time, and the async delivery queue counters. Polls
 *  session.jobs every 5s while mounted; a cancel triggers an immediate
 *  re-poll (nonce) instead of waiting for the next tick. */
function JobsPane({ rpc, sessionId }: { rpc: RpcClient; sessionId: string }): ReactNode {
	const [data, setData] = useState<JobsData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		if (!sessionId) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<JobsData>("session.jobs", { sessionId })
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
		const timer = setInterval(poll, 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId, nonce]);

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

	const running = data?.running ?? [];
	const recent = data?.recent ?? [];
	const delivery = data?.delivery;
	return (
		<div className="px-1 py-2">
			<div className="gui-group-label px-2 pb-1 pt-1">{t("jobs running")}</div>
			{running.length === 0 ? (
				<p className="px-2 py-1 text-[12px] text-[var(--color-text-faint)]">—</p>
			) : (
				<div className="flex flex-col gap-1 px-2">
					{running.map(job => (
						<div key={job.id} className="flex items-center gap-2 text-[13px]">
							<Icon
								name="loader-4"
								className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-[var(--color-accent)]"
							/>
							<span className="min-w-0 flex-1 truncate">{job.label || job.type}</span>
							<button
								type="button"
								className="gui-pane-action !w-auto flex-shrink-0 px-1.5 text-[12px]"
								title={t("jobs cancel")}
								aria-label={`${t("jobs cancel")}: ${job.label || job.id}`}
								disabled={cancelling !== null}
								onClick={() => void cancelJob(job.id)}
							>
								{cancelling === job.id ? (
									<Icon name="loader-4" className="h-3 w-3 animate-spin" />
								) : (
									<Icon name="close" className="h-3 w-3" />
								)}
								<span>{t("jobs cancel")}</span>
							</button>
						</div>
					))}
				</div>
			)}
			<div className="gui-group-label px-2 pb-1 pt-3">{t("jobs recent")}</div>
			{recent.length === 0 ? (
				<p className="px-2 py-1 text-[12px] text-[var(--color-text-faint)]">—</p>
			) : (
				<div className="flex flex-col gap-1 px-2">
					{recent.map(job => (
						<div key={job.id} className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
							<span className="min-w-0 flex-1 truncate">{job.label || job.type}</span>
							<span className="flex-shrink-0">{job.status}</span>
							<span className="flex-shrink-0 tabular-nums">{fmtJobTime(job.startTime)}</span>
						</div>
					))}
				</div>
			)}
			{delivery && (
				<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 text-[12px] text-[var(--color-text-muted)]">
					<span className="inline-flex items-center gap-1">
						<Icon name="inbox-archive" className="h-3.5 w-3.5" />
						{t("jobs queued")} {delivery.queued ?? 0}
					</span>
					<span className="inline-flex items-center gap-1">
						{t("jobs delivering")} {delivery.delivering ? "✓" : "—"}
					</span>
					<span className="inline-flex items-center gap-1">
						{t("jobs pending")} {delivery.pendingJobIds?.length ?? 0}
					</span>
				</div>
			)}
			{error && <div className="px-2 pt-2 text-[12px] leading-relaxed text-[var(--color-danger)]">{error}</div>}
		</div>
	);
}

/** Injected element-picker (bitfun/openchamber parity): hover highlight +
 *  click capture inside the webview; resolves {tag, text, selector,
 *  outerHTML} via executeJavaScript (cross-origin safe). */
const BROWSER_INSPECT_SCRIPT = `(() => {
	const { promise, resolve } = Promise.withResolvers();
	const overlay = document.createElement("div");
	overlay.style.cssText =
		"position:fixed;pointer-events:none;z-index:2147483647;background:rgba(66,133,244,0.15);outline:2px solid #4285f4;display:none;";
	const tip = document.createElement("div");
	tip.style.cssText =
		"position:fixed;pointer-events:none;z-index:2147483647;background:#1a1a1a;color:#fff;font:11px monospace;padding:2px 6px;border-radius:3px;display:none;";
	document.documentElement.appendChild(overlay);
	document.documentElement.appendChild(tip);
	const cssPath = el => {
		if (el.id) return "#" + el.id;
		const parts = [];
		let node = el;
		while (node && node.nodeType === 1 && parts.length < 6) {
			let part = node.tagName.toLowerCase();
			if (node.className && typeof node.className === "string") {
				part += "." + node.className.trim().split(/\\s+/).slice(0, 3).join(".");
			}
			const parent = node.parentElement;
			if (parent) {
				const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
				if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
			}
			parts.unshift(part);
			node = parent;
		}
		return parts.join(" > ");
	};
	let current = null;
	const cleanup = () => {
		document.removeEventListener("mousemove", onMove, true);
		document.removeEventListener("click", onClick, true);
		document.removeEventListener("keydown", onKey, true);
		overlay.remove();
		tip.remove();
	};
	const onMove = e => {
		const el = document.elementFromPoint(e.clientX, e.clientY);
		if (!el || el === overlay || el === tip) return;
		current = el;
		const r = el.getBoundingClientRect();
		overlay.style.display = "block";
		overlay.style.left = r.left + "px";
		overlay.style.top = r.top + "px";
		overlay.style.width = r.width + "px";
		overlay.style.height = r.height + "px";
		tip.textContent = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");
		tip.style.display = "block";
		tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 160) + "px";
		tip.style.top = e.clientY + 12 + "px";
	};
	const onClick = e => {
		e.preventDefault();
		e.stopPropagation();
		const el = current || document.elementFromPoint(e.clientX, e.clientY);
		cleanup();
		if (!el) return resolve(null);
		resolve({
			tag: el.tagName.toLowerCase(),
			text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500),
			selector: cssPath(el),
			outerHTML: el.outerHTML.slice(0, 2000),
		});
	};
	const onKey = e => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		cleanup();
		resolve(null);
	};
	document.addEventListener("mousemove", onMove, true);
	document.addEventListener("click", onClick, true);
	document.addEventListener("keydown", onKey, true);
	return promise;
})()`;

interface PickedElement {
	tag: string;
	text: string;
	selector: string;
	outerHTML: string;
}

/** Read the webview page's current text selection (cross-origin safe via
 *  <webview> executeJavaScript) for the selection→ask popover. */
const BROWSER_ASK_SELECTION_SCRIPT = `(() => {
	const sel = window.getSelection();
	const text = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.toString().replace(/\\r\\n?/g, "\\n").trim() : "";
	if (!text) return null;
	return { text, title: document.title || "" };
})()`;

const BROWSER_VIEWPORTS = [
	{ labelKey: "viewport fit", width: null },
	{ labelKey: "viewport phone", width: 393 },
	{ labelKey: "viewport tablet", width: 768 },
	{ labelKey: "viewport desktop", width: 1440 },
] as const;

/**
 * Browser tool pane: the managed in-app browser (Electron WebContentsView +
 * local CDP bridge) when the shell exposes it — the SAME browser the agent
 * drives with `browser.gui`. Plain-browser builds fall back to the legacy
 * webview/iframe pane.
 */
function BrowserPane({
	rpc,
	browserOpenRequest = null,
}: {
	rpc: RpcClient;
	browserOpenRequest?: { url: string; nonce: number } | null;
}): ReactNode {
	const managed = typeof window.electronAPI?.managedBrowserOpen === "function";
	if (managed) return <ManagedBrowserPane openRequest={browserOpenRequest} />;
	return <LegacyBrowserPane rpc={rpc} />;
}

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
				const insertion = `${t("inserted element", { tag: picked.tag, text: picked.text.slice(0, 80) })}\n${t("inserted element selector")}: ${picked.selector}`;
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
						context: picked.title ? `${t("ask browser selection")}: ${picked.title}` : undefined,
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
				<div className="flex items-center gap-1 overflow-x-auto px-1 pb-1">
					<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">{t("agent tabs")}:</span>
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
						alt={t("agent tab preview")}
						className="block h-24 w-full object-cover object-top opacity-80"
					/>
					<button
						type="button"
						className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded bg-[rgba(0,0,0,0.6)] text-[10px] text-white"
						aria-label={t("close")}
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
					aria-label={t("back")}
					title={t("back")}
					disabled={histIndex <= 0}
					onClick={back}
				>
					<Icon name="arrow-left" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-1.5"
					aria-label={t("forward")}
					title={t("forward")}
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
					aria-label={loading ? t("loading…") : t("refresh")}
					title={loading ? t("loading…") : t("refresh")}
					aria-busy={loading ? "true" : undefined}
					onClick={refresh}
				>
					<Icon name="refresh" className={`h-3.5 w-3.5${loading ? " gui-spin" : ""}`} />
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					aria-label={t("open in browser")}
					title={t("open in browser")}
					onClick={() => void openExternalUrl(current)}
				>
					<Icon name="external-link" className="h-3.5 w-3.5" />
				</button>
				{electron && (
					<button
						type="button"
						className={`gui-pane-action !w-auto px-2${picking ? " gui-view-opt--active" : ""}`}
						aria-label={picking ? t("stop picking element") : t("pick element")}
						title={picking ? t("stop picking element") : t("pick element")}
						onClick={() => void pickElement()}
					>
						<Icon name="cursor" className="h-3.5 w-3.5" />
					</button>
				)}
				{electron && (
					<button
						type="button"
						className="gui-pane-action !w-auto px-2"
						aria-label={t("ask about page selection")}
						title={t("ask about page selection")}
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
							title={t("browser")}
							onLoad={() => setLoading(false)}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
