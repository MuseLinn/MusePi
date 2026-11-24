import {
	buildTurnIndex,
	CodeHighlightProvider,
	ComputerViewerPipView,
	downloadBlob,
	isBranchFormingEntry,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	motionDisabled,
	relTime,
	SessionErrorDock,
	springEasing,
	Transcript,
	type TranscriptAnchor,
	type TranscriptAnchorCtl,
	type TranscriptNodeInjection,
	type TranslationKey,
	type TurnIndexItem,
	t,
} from "@musepi/client-core";
import { openPlanFromChat } from "@musepi/client-core/src/components/transcript/canvas-jump";
import {
	createChatQuoteContext,
	type DisplayContext,
	type MessageDisplayContext,
} from "@musepi/client-core/src/messages/display-context";
import { useDeepScrollShadow } from "@musepi/client-ui-primitives/client";
import type { ChatQuoteAnchor, OfficeQuoteAnchor, PdfQuoteAnchor, SessionEntry } from "@musepi/pi-wire";
import { Info as InfoIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pushActionToast } from "../lib/action-toast";
import { type AgentOutcome, agentSignalsFromSnapshot } from "../lib/agent-signals";
import { browserPanelDescriptor } from "../lib/browser-panel-tabs";
import { companionMoodFromSession, companionStateFromSignals, thinkingOrbStateFromSession } from "../lib/companion";
import type { ComposerAttachApi } from "../lib/composer-attach";
import { redirectKeyToComposer, redirectPasteToComposer } from "../lib/composer-input-redirect";
import {
	publishComposerInsets,
	publishFloatingPanelClearance,
	registerComposerInsetReader,
	withdrawComposerInsets,
	withdrawFloatingPanelClearance,
} from "../lib/composer-inset-readers";
import {
	FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX,
	FLOATING_COMPOSER_GAP_PX,
	forgetComposerSlot,
	recordComposerSlotHeight,
} from "../lib/composer-tail-inset";
import { containingBlockOrigin } from "../lib/containing-block-origin";
import { FILE_WORKSPACE_SURFACE } from "../lib/file-workspace";
import { useChatHighlight } from "../lib/highlight";
import { HISTORY_PAGE_MESSAGES } from "../lib/history-batch";
import { type JumpTarget, resolveJumpEntryId } from "../lib/jump-target";
import { EMPTY_TRUSTED_WALK, filterVisibleEntries, walkLeafPath } from "../lib/leaf-walk";
import { dispatchNotification } from "../lib/notify";
import { toolPanelTabDescriptor } from "../lib/panel-tabs";
import { type PendingToolCallWire, pendingToolCallsNotice } from "../lib/pending-tool-calls";
import { useConfirm } from "../lib/prompt-dialog";
import { rasterizeToBlob } from "../lib/rasterize";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionStore } from "../lib/session-store";
import { onSettingsChanged } from "../lib/settings-events";
import {
	COMPOSER_BAR_SLOT,
	CONVERSATION_CHAT_NODE_SLOT,
	PANEL_SHELL_SLOT,
	PANEL_TAB_SLOT_PREFIX,
	preloadSlotModules,
	resolveManagedBrowserPanelTab,
	SlotComponentHost,
	SlotComponentMount,
	selectPanelTabComponent,
	selectTranscriptNodeComponents,
	useExtensionScrollbarSkins,
	useExtensionToolViews,
	useExtensionWidgets,
	useSlotComponents,
	useSlotComponentsByPrefix,
} from "../lib/slot-host";
import {
	ADVISOR_AGENT_ROLE,
	agentDisplayName,
	agentRoleLabel,
	DEFAULT_AGENT_ROLE,
	useAgentRole,
} from "../lib/surfaces/agent-role";
import {
	AGENT_INFO_SURFACE,
	COMPACTION_PANEL_SURFACE,
	compactionTabDescriptor,
	sessionAgentTabDescriptor,
	surfaceById,
	surfaceRequiresSession,
} from "../lib/surfaces/registry";
import { setDockOpen } from "../lib/terminal-dock-state";
import { transcriptPathIds } from "../lib/turn-map-path";
import { type UsePanelTabsResult, usePanelTabs } from "../lib/use-panel-tabs";
import { usePointerDrag } from "../lib/use-pointer-drag";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { useStore } from "../lib/use-store";
import { createIncrementalSpeaker, type IncrementalSpeaker, speak } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";
import { ApprovalCard } from "./ApprovalCard";
import { type AskAnswer, AskCard, type AskRequest } from "./AskCard";
import { McpAuthCard, type McpAuthCardState, type McpAuthRequest } from "./McpAuthCard";
import { AskPopover } from "./AskPopover";
import { BtwFloatingCard } from "./BtwFloatingCard";
import { ChatDropAnchor } from "./ChatDropAnchor";
import { ChatFind, type FindHit } from "./ChatFind";
import { Composer, type HeroComposerProps } from "./Composer";
import type { CreationMessage } from "./CreationModeRow";
import { flushPendingConnectorSelection } from "./composer/connector-panel";
import { MessageTreeButton } from "./MessageTree";
import type { ReminderRow } from "./RemindersPanel";
import { Reveal } from "./Reveal";
import { RightRail } from "./RightRail";
import { SaveImageDialog } from "./SaveImageDialog";
import { type SecretAnswer, SecretCard, type SecretRequest } from "./SecretCard";
import { SelectionToolbar } from "./SelectionToolbar";
import { SessionArtifactPreviewDialog, type SessionArtifactPreviewRequest } from "./SessionArtifactPreviewDialog";
import type { SessionComposerProps } from "./SessionComposer";
import { type BreadcrumbSegment, SessionTreeNav } from "./SessionTreeNav";
import { SplitterGrip } from "./SplitterGrip";
import { SESSION_INFO_DOCK_MIN_ROW_PX, SessionInfoCard } from "./session-info-card";
import { TerminalPanel } from "./TerminalPanel";
import type { ThinkingLevel } from "./ThinkingSelector";
import { TurnMapCanvas } from "./TurnMapCanvas";
import { TurnRail } from "./TurnRail";

/** Stable empty map for the desktop preview before a session store lands. */
const EMPTY_ACTIVE_TOOLS: ReadonlyMap<string, never> = new Map<string, never>();

/** session.history 分页响应，供 store 按需请求下一页。 */
interface HistoryPage {
	entries: SessionEntry[];
	hasMore: boolean;
	remaining: number;
	/** 显式下一锚点(P0-3):整页重叠时客户端采用它推进游标。 */
	nextBeforeId?: string | null;
	/** 游标失效(P0-3):daemon 不再回退到最新页,客户端据此停止分页。 */
	stale?: boolean;
}

/** "mm:ss" hold time for the pause banner; re-rendered by a 1s tick. */
function formatPauseElapsed(pausedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - pausedAt) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * `display.liveActivityRows` → the row count the transcript wants.
 *
 * The setting is a NAMED choice ("all" | "3" | "5" | "7" | "10"), not a bare
 * integer: "0" reads to a user as "show nothing" rather than "no limit", and an
 * enum also stops a typo from blanking the running turn. `0` is what the
 * transcript means by unlimited.
 */
function activityRowsToNumber(value: unknown): number {
	if (typeof value !== "string") return 0;
	if (value === "all") return 0;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Center pane — ONE rounded floating surface hosting two scenes:
 *  - welcome (no session): greeting, watermark, centered composer with
 *    border-beam glow; fades/zooms out when a session appears.
 *  - session: header (title/status + terminal & right-panel toggles in
 *    the top-right), transcript with the session-bound
 *    ContextPanel nested beneath it, bottom composer, optional dock.
 *
 * Immersive layout: the session-bound right panel lives INSIDE this
 * surface; the global session sidebar stays a separate full-height pane
 * whose controls float on the boundary next to this surface.
 */

function openChatViewBrowserPanel(panelTabs: UsePanelTabsResult, sessionId: string | null, forceNew = false): void {
	const managed = resolveManagedBrowserPanelTab({ forceNew, sessionId });
	const existing = panelTabs.tabs.find(tab => tab.surface === "browser" && tab.target === managed.id);
	panelTabs.open(browserPanelDescriptor(managed, t("tools.browserEmptyTab")), {
		column: existing?.column,
		maxPerSurface: Number.POSITIVE_INFINITY,
	});
}

/** Exit window shared by both session-info seats (matches the card's 180ms
 *  entrance and the right panel's 220ms width fold). */
const SESSION_INFO_SEAT_EXIT_MS = 180;

/** Focus-mode composer morph. The surface changes shape — a compact box
 *  becomes a full-height editor — so it uses a spring, like every other
 *  morph in the app. CRITICALLY DAMPED (bounce 0), not the 6% overshoot this
 *  used to carry: the composer is bottom-anchored, so an overshooting height
 *  pushes its top edge past the surface it is growing into and the settle
 *  reads as a bump against the window edge. The welcome form morphs on a
 *  zero-overshoot 280ms curve and both states must read the same.
 *  The curve is sampled from the shared spring resource AT MODULE LOAD, so
 *  there is no hardcoded copy of the stops to drift out of sync. */
const COMPOSER_MORPH_MS = 280;
const COMPOSER_MORPH_EASING = springEasing(
	{ visualDuration: COMPOSER_MORPH_MS / 1000, bounce: 0 },
	16,
	COMPOSER_MORPH_MS,
);

/**
 * Keep a node mounted for one exit animation. `open` mounts on the next
 * render; closing flips `closing` and unmounts after the exit window, so CSS
 * can play the reverse animation instead of the node disappearing between
 * frames. Motion-off collapses the window to 0ms — no invisible delay.
 */
function useExitPresence(open: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
	const [mounted, setMounted] = useState(open);
	const [closing, setClosing] = useState(false);
	useEffect(() => {
		if (open) {
			setMounted(true);
			setClosing(false);
			return;
		}
		if (!mounted) return;
		const reduced = motionDisabled();
		setClosing(true);
		const timer = window.setTimeout(
			() => {
				setMounted(false);
				setClosing(false);
			},
			reduced ? 0 : exitMs,
		);
		return () => window.clearTimeout(timer);
	}, [open, exitMs, mounted]);
	return { mounted, closing };
}

/** Terminal dock resize bounds — one source for the pointer drag, the
 *  keyboard step and the persisted right-dock width. */
const TERMINAL_DOCK_HEIGHT_MIN = 96;
const TERMINAL_DOCK_HEIGHT_MAX = 480;
const TERMINAL_DOCK_RIGHT_WIDTH_MIN = 240;
const TERMINAL_DOCK_RIGHT_WIDTH_MAX = 720;

function clampDockHeight(height: number): number {
	return Math.min(TERMINAL_DOCK_HEIGHT_MAX, Math.max(TERMINAL_DOCK_HEIGHT_MIN, height));
}

function clampDockRightWidth(width: number): number {
	return Math.min(TERMINAL_DOCK_RIGHT_WIDTH_MAX, Math.max(TERMINAL_DOCK_RIGHT_WIDTH_MIN, width));
}

/**
 * 消息流顶部预留的头部带(px)。`.gui-chat-column .gui-transcript` 的
 * padding-top 与它同名同值(gui-chat.css,由 transcript-top-fade.test 守住):
 * 内容在这段距离内还没滑到头部行之下,顶部羽化不得出现——否则那条 56px
 * 的带子整块盖在空白头部带上,读成容器上边缘的高亮。
 */
export const TRANSCRIPT_HEAD_INSET = 52;

/** 模块级冻结对象:两个 hook 都按引用比较依赖,内联对象会每次渲染重挂。 */
const TRANSCRIPT_SCROLL_EDGE = { topInset: TRANSCRIPT_HEAD_INSET } as const;

export function ChatView({
	store,
	rpc,
	readOnly = false,
	mini = false,
	parentSession,
	onOpenParentSession,
	onOpenSession,
	onSend,
	onStop,
	onDecideApproval,
	onReloadSession,
	onForkSession,
	modes,
	modeId,
	onModeChange,
	/** M3.7a(v2 修订):design 模式内联形态的发送管线 —— 透传给欢迎页 composer。 */
	onDesignSubmit,
	defaultModelId,
	presetThinkingLevel,
	busy,
	project,
	onProject,
	onSubmitNewSession,
	rightPanelOpen,
	onOpenFileInPanel,
	onAddProvider,
	onOpenSettings,
	onToggleRightPanel,
	onExpandRightPanel,
	panelSelectRequest,
	terminalOpen,
	onCloseTerminal,
	onToggleTerminal,
	focusMode,
	onToggleFocus,
	paused,
	pausedAt,
	onResume,
	reminders,
	onSelectReminder,
	onMarkAllRead,
	sessionLoading,
	waitSeconds,
	ask,
	onAskAnswer,
	mcpAuth,
	onMcpAuthAuthorize,
	onMcpAuthCancel,
	onMcpAuthDismiss,
	sessionTitle,
	sessionInfoOpen = false,
	onToggleSessionInfo,
}: {
	store: GuiSessionStore | null;
	rpc: RpcClient;
	/** 顾问 transcript 只读态（session.tree 行的 advisor 标记传入）：
	 *  转录照常浏览，输入区替换为只读说明条，禁止发送。 */
	readOnly?: boolean;
	/** 纯聊天表面（Electron mini 窗）：右侧 rail 与面板是工作区 chrome，
	 *  mini 窗只保留 transcript + composer，两者都不渲染。 */
	mini?: boolean;
	/** 当前会话的父会话(fork 来源 / 子代理宿主)——非空时会话卡顶部行左缘
	 * 渲染「父级」返回按钮。 */
	parentSession?: { id: string; label: string | null } | null;
	/** 切换主视图到父会话。 */
	onOpenParentSession?(id: string): void;
	/** 切换主视图到任意会话(子会话行点击)——app.tsx 的 openSession。 */
	onOpenSession?(id: string): void;
	onSend(
		text: string,
		images?: { type: "image"; data: string; mimeType: string }[],
		deliverAs?: "prompt" | "steer" | "followUp",
		displayContext?: MessageDisplayContext,
		videos?: { type: "video"; mimeType: string; url?: string; data?: string }[],
		/** Branch parent the prompt attaches under; the optimistic echo needs
		 *  it so the transcript keeps one active path after a rewind. */
		parentId?: string | null,
	): void;
	onStop(): void;
	onDecideApproval(requestId: string, approved: boolean, note?: string): void;
	/** Reload the active session snapshot (revert/edit truncation). */
	onReloadSession?(): Promise<void> | void;
	/** Open a forked session (session.forkAt result) — switches the UI to
	 *  the new branch and refreshes the tree. */
	onForkSession?(sessionId: string): Promise<void> | void;
	/** @deprecated The session composer no longer seeds a model — a live
	 *  session reads its own model and the agent info tab owns the switch.
	 *  Kept on the prop surface for the app's handoff wiring. */
	presetModelId?: string | null;
	/** Welcome 预设(mode)chip(welcome 场景;modes 未传则不渲染,见 Composer)。 */
	modes?: { id: string; label: string }[] | null;
	modeId?: string | null;
	onModeChange?(id: string | null): void;
	/** M3.7a design 模式内联形态(§2.4):session.create + projectMetadata 管线。 */
	onDesignSubmit?(metadata: Record<string, unknown>, message?: CreationMessage): Promise<boolean>;
	/** The DEFAULT-role model (modelRoles.default): the welcome composer's
	 *  resting preselect for NEW sessions. Separate from presetModelId so
	 *  opening/switching sessions never changes what the welcome shows. */
	defaultModelId?: string | null;
	/** Daemon thinking default (boot snapshot) for the welcome composer. */
	presetThinkingLevel?: ThinkingLevel | null | undefined;
	/** Welcome scene (before the first session of the run). */
	busy: boolean;
	project: string | null;
	onProject(action: "folder" | "remote" | "none" | string): void;
	onSubmitNewSession(
		text: string,
		opts?: {
			thinkingLevel?: ThinkingLevel | null;
			modelId?: string | null;
			images?: { type: "image"; data: string; mimeType: string }[];
			videos?: { type: "video"; mimeType: string; url?: string; data?: string }[];
			/** Armed welcome mode chips: applied to the session the first
			 *  prompt creates (goal: the prompt text becomes the objective). */
			planMode?: boolean;
			goalMode?: boolean;
		},
	): void;
	/** Process-global agent freeze (TUI /pause parity): banner over the
	 *  transcript while engaged, with a live hold timer. */
	paused?: boolean;
	pausedAt?: number | null;
	onResume?(): void;
	/** Session-bound right panel (context/files/terminal tools),
	 * "打开标签页" style — nested under the transcript inside this surface. */
	rightPanelOpen: boolean;
	/** Reveal a file in the right panel: the caller (App) opens the panel;
	 *  ChatView relays the path into the ContextPanel/FilePane preview. */
	onOpenFileInPanel?(path: string): void;
	/** 添加新提供商 menu action (composer model menu) — opens the
	 *  settings providers page. */
	onAddProvider?(): void;
	/** Open the settings surface at a section (tool-card "fix this in
	 *  settings" actions, e.g. web search provider failures). */
	onOpenSettings?(section?: string): void;
	/** Right-edge rail (RightRail) fold toggle — expands/collapses the
	 *  ContextPanel (app owns the persisted state). */
	onToggleRightPanel?(): void;
	/** Right-edge rail: expand the panel without toggling when a tool icon
	 *  is picked while the panel is collapsed. */
	onExpandRightPanel?(): void;
	/** ⌘1..8 surface jump (design-doc遗留项落地): App turns the shortcut
	 *  into a select request carrying a nonce; the nonce bump re-fires the
	 *  effect even when the same surface is requested twice. */
	panelSelectRequest?: { id: string; nonce: number } | null;
	terminalOpen: boolean;
	/** Last terminal tab closed → fold the dock (TerminalPanel onAllClosed). */
	onCloseTerminal?(): void;
	/** Right-rail terminal toggle: the rail button replaces the old
	 *  header one (the header keeps none). */
	onToggleTerminal?(): void;
	/** Focus mode: composer fills the surface. */
	focusMode: boolean;
	onToggleFocus(): void;
	/** Welcome-scene reminders (kimi 实时提醒 parity): background-working +
	 *  completed-unread sessions below the empty composer. */
	reminders?: readonly ReminderRow[];
	onSelectReminder?(sessionId: string): void;
	onMarkAllRead?(): void;
	/** History-session cold open in flight: show the skeleton overlay
	 *  over the transcript until the store lands. */
	sessionLoading?: boolean;
	/** Seconds the open has been waiting, for the skeleton's elapsed readout. */
	waitSeconds?: number;
	/** Pending ask question (TUI ask parity): the daemon pushed an
	 *  ask-request envelope — the floating card above the composer answers
	 *  via onAskAnswer (session.askAnswer). */
	ask?: AskRequest | null;
	onAskAnswer?(answer: AskAnswer): void;
	/** Pending MCP authorization: a tool call parked on a server's browser
	 *  grant. Same slot as the ask card — placement belongs to this container,
	 *  not to the card. */
	mcpAuth?: (McpAuthRequest & { state?: McpAuthCardState; error?: string }) | null;
	onMcpAuthAuthorize?(request: McpAuthRequest): void;
	onMcpAuthCancel?(request: McpAuthRequest): void;
	onMcpAuthDismiss?(request: McpAuthRequest): void;
	/** Session title shown in the floating session info card (app.tsx owns the
	 *  session label; the card is the collapsed right panel's stand-in). */
	sessionTitle?: string | null;
	/** Session info card visibility (app.tsx persists one choice per session). */
	sessionInfoOpen?: boolean;
	onToggleSessionInfo?(): void;
}): ReactNode {
	const noopSubscribe = (): (() => void) => () => {};
	const snap = useStore(
		store ? store.subscribe.bind(store) : noopSubscribe,
		store ? store.getSnapshot.bind(store) : () => null,
	);
	// 扩展 per-tool 渲染器(registerToolView):
	// 注册进 guest-client tool-render 外部表,transcript 按工具名分派。
	useExtensionToolViews(rpc);
	// Widget types contributed by plugins (registerWidget): compile the card
	// renderer and register it beside the built-in widget types.
	useExtensionWidgets(rpc);
	// Scrollbar skins contributed by theme bundles (registerScrollbarSkin):
	// publish them into the shared skin registry the floating rail reads.
	useExtensionScrollbarSkins(rpc);
	// Presentation switches (widget/board) must apply without a restart: after
	// any settings write, ask the daemon to drop tools that are now disabled.
	useEffect(() => {
		const sessionId = store?.sessionId;
		if (!rpc || !sessionId) return;
		const sync = (): void => {
			void rpc.request("session.toolGates", { sessionId }).catch(() => {});
		};
		return onSettingsChanged(sync);
	}, [rpc, store?.sessionId]);
	// Secret request cards: the daemon pushes `secret-request` on this
	// session's stream. Requests stay independent per requestId (parallel
	// tool calls can raise several); the value never enters the store —
	// SecretCard holds it for the duration of the input and answers through
	// secret.answer.
	const [secretRequests, setSecretRequests] = useState<readonly SecretRequest[]>([]);
	// Requests this window has already answered. The daemon broadcasts
	// `secret-request-end` to every subscriber — including this one, one
	// batcher beat after the RPC result. Those local ids keep their resolved
	// line until SecretCard's linger calls onSettled; only foreign ends
	// (another device answered, or the ten-minute timeout) drop a card.
	const answeredSecretRequestsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const sessionId = store?.sessionId;
		return rpc.addEventListener(event => {
			// Own session only: an envelope without a session id is not this
			// chat's request, and a foreign session gets its own card.
			if (!sessionId || event.sessionId !== sessionId) return;
			if (event.kind === "secret-request") {
				const payload = event.payload as Partial<SecretRequest> | undefined;
				if (
					!payload ||
					typeof payload.requestId !== "string" ||
					typeof payload.name !== "string" ||
					typeof payload.purpose !== "string" ||
					(payload.kind !== "fill" && payload.kind !== "allow")
				) {
					return;
				}
				const next: SecretRequest = {
					requestId: payload.requestId,
					name: payload.name,
					purpose: payload.purpose,
					kind: payload.kind,
					delivery: payload.delivery === "file" ? "file" : "env",
				};
				// A subscribe replay of a request already on screen keeps one card.
				setSecretRequests(current =>
					current.some(item => item.requestId === next.requestId) ? current : [...current, next],
				);
				return;
			}
			// Another device answered, or the request timed out as cancel.
			if (event.kind === "secret-request-end") {
				const requestId = (event.payload as { requestId?: unknown } | undefined)?.requestId;
				// A locally answered request keeps its settled line — the end
				// broadcast for it is this window's own write coming back.
				if (typeof requestId === "string" && !answeredSecretRequestsRef.current.has(requestId)) {
					setSecretRequests(current => current.filter(item => item.requestId !== requestId));
				}
			}
		});
	}, [rpc, store?.sessionId]);
	const answerSecret = useCallback(
		async (answer: SecretAnswer): Promise<void> => {
			// Mark before the send: the end broadcast can arrive before the RPC
			// response resolves, so marking on success would race the card off
			// screen. Failure rolls the mark back.
			answeredSecretRequestsRef.current.add(answer.requestId);
			try {
				await rpc.request("secret.answer", {
					requestId: answer.requestId,
					action: answer.action,
					...(answer.value !== undefined ? { value: answer.value } : {}),
					...(answer.scope !== undefined ? { scope: answer.scope } : {}),
				});
			} catch (err) {
				answeredSecretRequestsRef.current.delete(answer.requestId);
				throw err;
			}
		},
		[rpc],
	);
	// Pause banner hold timer: tick every second while the freeze is engaged
	// so the "paused · mm:ss" clock advances.
	const [, setPauseTick] = useState(0);
	// A branch that ended mid-tool-call gets the TUI's resume warning here. The
	// daemon owns the detection; this re-reads it when the session opens and
	// whenever a turn settles, so a crash-then-reattach still reports it.
	const [pendingToolCalls, setPendingToolCalls] = useState<readonly PendingToolCallWire[] | null>(null);
	const [dismissedPendingCalls, setDismissedPendingCalls] = useState<string | null>(null);
	const sessionIdForPending = store?.sessionId;
	const workingForPending = snap?.working === true;
	useEffect(() => {
		if (!rpc || !sessionIdForPending) {
			setPendingToolCalls(null);
			return;
		}
		let cancelled = false;
		const current = store;
		const check = async (): Promise<void> => {
			try {
				const res = await rpc.request<{ calls: PendingToolCallWire[]; working?: boolean }>(
					"session.pendingToolCalls",
					{ sessionId: sessionIdForPending },
				);
				if (cancelled) return;
				setPendingToolCalls(res?.calls ?? []);
				// The daemon's own flag settles a run state this view inherited
				// from a crashed connection: no agent_end ever arrives, so a
				// reopened store can keep reporting a turn nobody is running.
				if (res?.working === false && current?.getSnapshot().working) current.adoptIdleState();
			} catch {
				if (!cancelled) setPendingToolCalls(null);
			}
		};
		void check();
		// Keep asking while this view believes a turn runs. The stream cannot
		// correct it by itself — the process that would have sent agent_end is
		// gone — and the flag would otherwise pin the stop capsule forever.
		const timer = workingForPending ? setInterval(() => void check(), 5_000) : null;
		return () => {
			cancelled = true;
			if (timer !== null) clearInterval(timer);
		};
	}, [rpc, sessionIdForPending, workingForPending, store]);
	const pendingCallsNotice = useMemo(
		() => (workingForPending ? null : pendingToolCallsNotice(pendingToolCalls ?? [])),
		[workingForPending, pendingToolCalls],
	);
	// Round-activity fold default (settings → 聊天). localStorage events do
	// not fire in the same document, so PrefToggle dispatches the companion
	// event; re-rendering here lets the Transcript reinterpret ALL existing
	// round deviations immediately (no reload / no migration).
	const [defaultRoundFoldExpanded, setDefaultRoundFoldExpanded] = useState(() => {
		try {
			return localStorage.getItem("musepi-gui-chat-roundfold") === "1";
		} catch {
			return false;
		}
	});
	useEffect(() => {
		const onChanged = (e: Event): void => {
			const detail = (e as CustomEvent<boolean>).detail;
			setDefaultRoundFoldExpanded(detail === true);
		};
		window.addEventListener("musepi-roundfold-default-changed", onChanged);
		return () => window.removeEventListener("musepi-roundfold-default-changed", onChanged);
	}, []);
	// 工具调用汇总 (settings → 聊天, default ON): consecutive tool calls
	// summarize into one line per run. Same companion-event pattern as the
	// round-fold default (localStorage events do not fire in the same
	// document) so flipping the toggle re-renders the live transcript.
	const [stickyUserPrompt, setStickyUserPrompt] = useState(() => {
		try {
			return (localStorage.getItem("musepi-gui-chat-stickyprompt") ?? "1") !== "0";
		} catch {
			return true;
		}
	});
	useEffect(() => {
		const onChanged = (event: Event): void => {
			setStickyUserPrompt((event as CustomEvent<boolean>).detail);
		};
		window.addEventListener("musepi-stickyprompt-changed", onChanged);
		return () => window.removeEventListener("musepi-stickyprompt-changed", onChanged);
	}, []);
	const [toolCallSummary, setToolCallSummary] = useState(() => {
		try {
			return (localStorage.getItem("musepi-gui-chat-toolsummary") ?? "1") !== "0";
		} catch {
			return true;
		}
	});
	useEffect(() => {
		const onChanged = (e: Event): void => {
			setToolCallSummary((e as CustomEvent<boolean>).detail === true);
		};
		window.addEventListener("musepi-toolsummary-changed", onChanged);
		return () => window.removeEventListener("musepi-toolsummary-changed", onChanged);
	}, []);
	/** TTS read-aloud 播放状态:行级指示 + 停止句柄。 */
	const [speakingId, setSpeakingId] = useState<string | null>(null);
	const stopSpeakRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (paused !== true) return;
		const timer = setInterval(() => setPauseTick(t => t + 1), 1_000);
		return () => clearInterval(timer);
	}, [paused]);
	// Recap relative timestamp: re-render once a minute while a recap is up.
	const [, setRecapTick] = useState(0);
	useEffect(() => {
		if (!snap?.recap) return;
		const id = window.setInterval(() => setRecapTick(t => t + 1), 60_000);
		return () => clearInterval(id);
	}, [snap?.recap]);
	// Recap card fold: long recaps collapse to one line; click to expand.
	const [recapExpanded, setRecapExpanded] = useState(false);
	// TUI display-settings parity: the transcript honors these daemon
	// settings (colorBlindMode, display.smoothStreaming / hideToolActivity
	// / showTokenUsage / collapseCompacted). Read once on mount and on
	// settings-panel commits (SchemaSettings dispatches the settings-changed
	// event). settings.get returns schema defaults, so
	// unconfigured keys resolve to the same values the TUI uses.
	const [displaySettings, setDisplaySettings] = useState<Record<string, unknown>>({});
	useEffect(() => {
		let alive = true;
		const load = (): void => {
			void rpc
				.request<Record<string, unknown>>("settings.get", {
					keys: [
						"colorBlindMode",
						"display.smoothStreaming",
						"display.hideToolActivity",
						"display.showTokenUsage",
						"display.collapseCompacted",
						"display.liveActivityRows",
						"display.taskCardStyle",
						"tts.autoRead",
						"tts.rate",
						"tts.inputMode",
						"tts.readMode",
						"tts.enhanced",
						"tts.localVoice",
					],
				})
				.then(v => {
					if (alive) setDisplaySettings(v ?? {});
				})
				.catch(() => {});
		};
		load();
		const off = onSettingsChanged(load);
		return () => {
			alive = false;
			off();
		};
	}, [rpc]);
	// display.smoothStreaming controls the reveal via the html class —
	// sole source since the chat-settings toggle merged into 外观 (the old
	// musepi-gui-chat-smooth localStorage key no longer writes it, so stale
	// values must not stick).
	useEffect(() => {
		const cls = document.documentElement.classList;
		if (displaySettings["display.smoothStreaming"] === false) {
			cls.add("gui-chat-no-smooth");
		} else {
			cls.remove("gui-chat-no-smooth");
		}
	}, [displaySettings["display.smoothStreaming"]]);
	// TTS 自动朗读(tts.autoRead): delta 级边生成边朗读。每次快照更新都把当前
	// 完整回复喂给同一个控制器；它只挑出新完成的句子合成，第一句出声时模型
	// 还在写下一段。回合/会话切换时重建控制器，回合结束时 flush 尾句。
	const autoSpeakerRef = useRef<IncrementalSpeaker | null>(null);
	const autoSpeakerKeyRef = useRef<string | null>(null);
	// The last assistant message already on screen when a session is opened is
	// history, not a new reply. Without this guard, enabling auto-read and
	// switching sessions would read that old reply (or the whole last turn)
	// aloud on mount.
	const autoReadBaselineRef = useRef<{ sessionId: string; lastId: string | null } | null>(null);
	useEffect(() => {
		if (displaySettings["tts.autoRead"] !== true || !rpc) {
			autoSpeakerRef.current?.stop();
			autoSpeakerRef.current = null;
			autoSpeakerKeyRef.current = null;
			return;
		}
		if (!snap) return;
		const mode = displaySettings["tts.readMode"];
		const includeThinking = mode === "all";
		const parts: string[] = [];
		let lastId: string | null = null;
		for (const e of snap.entries) {
			if (e.type === "message" && e.message.role === "user") {
				parts.length = 0; // turn boundary
				continue;
			}
			if (e.type !== "message" || e.message.role !== "assistant") continue;
			lastId = e.id;
			const blocks = e.message.content as { type?: string; text?: string; thinking?: string }[];
			const text = blocks
				.filter(block => block.type === "text" || (includeThinking && block.type === "thinking"))
				.map(block => block.text ?? block.thinking ?? "")
				.join(" ");
			if (text.trim()) parts.push(text);
		}
		if (!lastId) return;
		const sid = store?.sessionId ?? "";
		if (autoReadBaselineRef.current?.sessionId !== sid) {
			autoReadBaselineRef.current = { sessionId: sid, lastId };
		}
		// Skip a settled reply that was already present when the session
		// opened. A reply that STARTED streaming while mounted already owns a
		// controller, so it must still reach finish() below.
		if (
			!snap.streaming &&
			!snap.working &&
			lastId === autoReadBaselineRef.current.lastId &&
			autoSpeakerRef.current === null
		) {
			return;
		}
		const key = `${sid}:${lastId}`;
		if (autoSpeakerKeyRef.current !== key) {
			autoSpeakerRef.current?.stop();
			stopSpeakRef.current?.(); // manual read-aloud must not overlap
			stopSpeakRef.current = null;
			autoSpeakerKeyRef.current = key;
			autoSpeakerRef.current = createIncrementalSpeaker(
				rpc,
				{
					voice:
						typeof displaySettings["tts.localVoice"] === "string"
							? (displaySettings["tts.localVoice"] as string)
							: undefined,
					rate:
						typeof displaySettings["tts.rate"] === "number" ? (displaySettings["tts.rate"] as number) : undefined,
					mode:
						displaySettings["tts.inputMode"] === "raw" || displaySettings["tts.inputMode"] === "summarize"
							? displaySettings["tts.inputMode"]
							: undefined,
					enhanced: displaySettings["tts.enhanced"] === true,
					sessionId: store?.sessionId,
				},
				activity => {
					if (activity.phase === "speaking") setSpeakingId(lastId);
					else if (activity.phase === "done" || activity.phase === "stopped") {
						setSpeakingId(prev => (prev === lastId ? null : prev));
					} else if (activity.phase === "error") {
						setSpeakingId(prev => (prev === lastId ? null : prev));
						dispatchNotification("error", { lastMessage: activity.message });
					}
				},
			);
		}
		const fullText = mode === "yield" ? (parts.at(-1) ?? "") : parts.join(" ");
		if (fullText.trim()) autoSpeakerRef.current?.feed(fullText);
		if (!snap.streaming && !snap.working) autoSpeakerRef.current?.finish();
	}, [
		snap,
		rpc,
		store?.sessionId,
		displaySettings["tts.autoRead"],
		displaySettings["tts.rate"],
		displaySettings["tts.inputMode"],
		displaySettings["tts.readMode"],
		displaySettings["tts.enhanced"],
		displaySettings["tts.localVoice"],
	]);
	useEffect(
		() => () => {
			autoSpeakerRef.current?.stop();
		},
		[],
	);
	// One container, two scenes, BIDIRECTIONAL transition: the incoming
	// scene mounts (fade/zoom in) while the outgoing one lingers 420ms
	// with a fade-out before unmounting.
	//
	// The composer FRAME additionally FLIP-morphs between the two scenes
	// (welcome: large centered hero → session: compact footer bar, and
	// back): both frames exist during the overlap window, so the incoming
	// one is measured against the outgoing rect and animated with a
	// translate+scale transform — one continuous morph, no cross-fade.
	// Initial scene by the store present at MOUNT: entering from the
	// board/scheduled views mounts this component only after openSession
	// resolved, so a store is already here — showing the welcome scene
	// first (even briefly) would flash an empty chat before the session
	// fades in. Fresh mounts with no store (app start) start on welcome.
	const [showWelcome, setShowWelcome] = useState(() => !store);
	const [welcomeLeaving, setWelcomeLeaving] = useState(false);
	const [showChat, setShowChat] = useState(() => !!store);
	const [chatLeaving, setChatLeaving] = useState(false);
	// Which scene's card is on screen. The composer is no longer part of either
	// card — it lives in the persistent host below the scenes — so a flip only
	// swaps the card surfaces and the composer travels with its own FLIP.
	const sceneRef = useRef<"welcome" | "chat">(store ? "chat" : "welcome");
	useEffect(() => {
		const next = store ? "chat" : "welcome";
		const flip = sceneRef.current !== next;
		sceneRef.current = next;
		if (!flip) return;
		if (store) {
			setChatLeaving(false);
			setShowChat(true);
			setWelcomeLeaving(true);
			const timer = setTimeout(() => setShowWelcome(false), 420);
			return () => clearTimeout(timer);
		}
		setWelcomeLeaving(false);
		setShowWelcome(true);
		setChatLeaving(true);
		const timer = setTimeout(() => setShowChat(false), 420);
		return () => clearTimeout(timer);
	}, [store]);
	// Desktop-only tree-sitter highlighting for transcript code blocks.
	const chatHighlight = useChatHighlight();
	// Agent status via the thinking-orb state (avatar, not labels).
	// streaming = the assistant message has started streaming (view folds it
	// into entries at message_start — no separate ghost is kept). Pending
	// tool approvals pin `waiting` (the "paused for you" wave) — shared
	// helper with the header so both avatars tell the same story.
	const orb = thinkingOrbStateFromSession(snap);
	// Idle lifecycle clock: the avatar's drowsy/bored/sleeping ladder is measured
	// in tens of seconds, so one 15s tick is enough — a 1s timer would re-render
	// the transcript for nothing.
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNowMs(Date.now()), 15_000);
		return () => window.clearInterval(id);
	}, []);
	// Turn outcome: the working→idle edge is the only moment the avatar can
	// celebrate or alert. Held briefly, then the live facts win again; a new
	// turn clears it at once.
	const [turnOutcome, setTurnOutcome] = useState<AgentOutcome | null>(null);
	const wasWorkingRef = useRef(false);
	useEffect(() => {
		const workingNow = snap?.working === true || snap?.streaming === true;
		if (workingNow) {
			setTurnOutcome(null);
		} else if (wasWorkingRef.current) {
			const lastAssistant = [...(snap?.entries ?? [])]
				.reverse()
				.find(entry => entry.type === "message" && entry.message.role === "assistant");
			let failed = false;
			if (lastAssistant?.type === "message" && lastAssistant.message.role === "assistant") {
				failed = lastAssistant.message.stopReason === "error";
			}
			setTurnOutcome({ kind: failed ? "failure" : "success", at: Date.now() });
		}
		wasWorkingRef.current = workingNow;
	}, [snap?.working, snap?.streaming, snap?.entries]);
	useEffect(() => {
		if (!turnOutcome) return;
		const timer = window.setTimeout(() => setTurnOutcome(null), 4_000);
		return () => window.clearTimeout(timer);
	}, [turnOutcome]);
	const agentSignals = useMemo(
		() =>
			agentSignalsFromSnapshot(snap, {
				now: nowMs,
				...(turnOutcome ? { outcome: turnOutcome, justFinished: true } : {}),
			}),
		[snap, nowMs, turnOutcome],
	);
	// Avatar display toggle lives in Settings → appearance (musepi-gui-avatars).
	// The per-row avatars are gone (one identity per conversation), so this now
	// decides whether the agent capsule carries the orb or the text alone.
	const showAvatars = localStorage.getItem("musepi-gui-avatars") !== "0";
	// The agent's role: the daemon's `session.list` row is the source, with a
	// synchronous fallback so the capsule never waits to show an identity — the
	// workbench lane's `coder`, or `advisor` for the read-only transcript the app
	// already identified. A subagent session reads back as its own agent; it is
	// never relabeled as the session's coder.
	const agentRole = useAgentRole(rpc, store?.sessionId ?? null, readOnly ? ADVISOR_AGENT_ROLE : DEFAULT_AGENT_ROLE);
	// The capsule's status line. Approvals lead: the agent is parked on a
	// decision, which is the one state the human can act on.
	const agentCapsuleStatus = snap?.approvals.length
		? t("general.agentCapsuleWaiting")
		: snap?.working
			? t("general.agentCapsuleWorking")
			: t("general.agentCapsuleIdle");
	// Resizable terminal dock (drag the top edge).
	const [dockHeight, setDockHeight] = useState(176);
	// Dock side (bottom vs right). The TerminalPanel stays mounted across
	// switches so switching sides does not recreate pties.
	const [terminalPlacement, setTerminalPlacement] = useState<"bottom" | "right">(() =>
		localStorage.getItem("musepi-gui-terminal-placement") === "right" ? "right" : "bottom",
	);
	const [rightWidth, setRightWidth] = useState(() =>
		clampDockRightWidth(Number(localStorage.getItem("musepi-gui-terminal-right-width") ?? 360)),
	);
	useEffect(() => {
		const onPlacement = (event: Event): void => {
			const detail = (event as CustomEvent<"bottom" | "right">).detail;
			if (detail === "right" || detail === "bottom") setTerminalPlacement(detail);
		};
		window.addEventListener("musepi-gui-terminal-placement-changed", onPlacement as EventListener);
		return () => window.removeEventListener("musepi-gui-terminal-placement-changed", onPlacement as EventListener);
	}, []);
	const rightDockStartRef = useRef(rightWidth);
	const rightDockResizeDrag = usePointerDrag({
		onDragStart: () => {
			terminalDockRef.current?.classList.add("gui-terminal-dock--resizing");
			rightDockStartRef.current = rightWidth;
		},
		onDragMove: ({ dx }) => {
			setRightWidth(clampDockRightWidth(rightDockStartRef.current - dx));
		},
		onDragEnd: () => {
			terminalDockRef.current?.classList.remove("gui-terminal-dock--resizing");
			localStorage.setItem("musepi-gui-terminal-right-width", String(rightWidth));
		},
	});
	// Terminal dock resize — unified usePointerDrag primitive (pointer
	// capture + cancel; the old window-listener version leaked listeners
	// when the pointer left the window and stuck mid-drag on cancel).
	const dockStartRef = useRef(dockHeight);
	const dockResizeDrag = usePointerDrag({
		onDragStart: () => {
			// While dragging, suppress the open/close height transition so
			// the handle stays 1:1 with the pointer.
			terminalDockRef.current?.classList.add("gui-terminal-dock--resizing");
			dockStartRef.current = dockHeight;
		},
		onDragMove: ({ dy }) => {
			setDockHeight(clampDockHeight(dockStartRef.current - dy));
		},
		onDragEnd: () => {
			terminalDockRef.current?.classList.remove("gui-terminal-dock--resizing");
		},
	});
	// Keyboard step on a dock grip: 2 % of the current size, 10 % with Shift,
	// inside the same bounds as the pointer drag. Arrows move the seam, so
	// growing the dock is Up for the bottom dock and Left for the right dock.
	const nudgeDockHeight = (direction: -1 | 1, coarse: boolean): void => {
		const step = Math.max(1, Math.round(dockHeight * (coarse ? 0.1 : 0.02)));
		setDockHeight(clampDockHeight(dockHeight + direction * step));
	};
	const nudgeDockRightWidth = (direction: -1 | 1, coarse: boolean): void => {
		const step = Math.max(1, Math.round(rightWidth * (coarse ? 0.1 : 0.02)));
		const next = clampDockRightWidth(rightWidth + direction * step);
		setRightWidth(next);
		localStorage.setItem("musepi-gui-terminal-right-width", String(next));
	};
	const terminalDockRef = useRef<HTMLDivElement | null>(null);
	// The dock's grip pill is `position: fixed` because the dock shell clips its
	// children (the open/close height animation needs it). A fixed pill cannot
	// read the seam from layout, so the dock publishes the midpoint between the
	// chat card's bottom edge and its own top edge into `--gui-dock-resize-seam`
	// — the pill then sits IN the gap instead of on top of the card.
	useLayoutEffect(() => {
		const dock = terminalDockRef.current;
		if (!dock || !terminalOpen || terminalPlacement !== "bottom") return;
		const write = (): void => {
			const dockRect = dock.getBoundingClientRect();
			const card = document.querySelector(".gui-chat-column, .gui-welcome-card, .gui-float-card");
			const cardRect = card?.getBoundingClientRect();
			const seam = cardRect && cardRect.bottom <= dockRect.top ? (cardRect.bottom + dockRect.top) / 2 : dockRect.top;
			// Same counting-block correction as the right-panel grip: a `fixed`
			// pill resolves against the nearest transformed/filtered ancestor.
			const origin = containingBlockOrigin(dock);
			dock.style.setProperty("--gui-dock-resize-seam", `${seam - origin.y}px`);
			// The band is `fixed` and full-width; keep it on the chat column so
			// it never covers the sidebar or the right panel.
			dock.style.setProperty("--gui-dock-resize-seam-x", `${dockRect.left - origin.x}px`);
			dock.style.setProperty("--gui-dock-resize-w", `${dockRect.width}px`);
		};
		write();
		const observer = new ResizeObserver(write);
		observer.observe(dock);
		window.addEventListener("resize", write);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", write);
		};
	}, [terminalOpen, terminalPlacement, dockHeight]);
	// The dock shell below stays mounted so open/close animates; the
	// TerminalPanel inside mounts on the FIRST dock open anywhere in this
	// view and then NEVER unmounts. Visibility still follows the session
	// (dockOpen is per session; a session whose dock was never opened shows
	// the dock folded), but folding is height 0, not disposal — the running
	// ptys and their scrollback survive a session switch round trip
	// (previously switching to a never-opened session unmounted the panel,
	// killing the ptys; returning spawned a fresh PowerShell and lost the
	// scrollback). Only the first open spawns ptys, so a session that never
	// opens the dock still never pays for one.
	const dockSessionKey = store?.sessionId ?? "";
	const [terminalEverOpened, setTerminalEverOpened] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		if (terminalOpen) setTerminalEverOpened(prev => setDockOpen(prev, dockSessionKey, true));
	}, [terminalOpen, dockSessionKey]);
	const terminalPanelMounted = terminalOpen || terminalEverOpened.size > 0;
	const transcriptRef = useRef<HTMLDivElement | null>(null);
	// The scroller is the element whose mask IS the end fade, so it is the
	// reader for --chat-composer-inset. Its ref is shared with useScrollShadow
	// and two children, hence a callback that fans out rather than a swap.
	const releaseTranscriptInsetReader = useRef<(() => void) | undefined>(undefined);
	const transcriptScrollerRef = useCallback((el: HTMLDivElement | null) => {
		releaseTranscriptInsetReader.current?.();
		releaseTranscriptInsetReader.current = registerComposerInsetReader(el) ?? undefined;
		transcriptRef.current = el;
	}, []);
	// 内容边界羽化:纵向上下羽化(transcript 自身,修复静态 data 属性从不
	// 更新的死接线)+ 深扫描消息内的工具渲染横向滚动块(tv-pre / diff,
	// 同 mask 配方,只在横向溢出时显示左右羽化)。顶部羽化带滚过 52px
	// 头部预留才出现——见 TRANSCRIPT_HEAD_INSET。
	useScrollShadow(transcriptRef, undefined, TRANSCRIPT_SCROLL_EDGE);
	useDeepScrollShadow(transcriptRef, ".tv-pre, .tv-diff, .tv-diff-sbs-cell", TRANSCRIPT_SCROLL_EDGE);

	/**
	 * Type anywhere, land in the composer.
	 *
	 * With nothing focused — after scrolling the conversation, or coming back
	 * to the window — a keystroke should start a message. The guards live in
	 * `composer-input-redirect`: a field, a page, a focused control, a floating
	 * layer or an active text selection all keep their own input. Paste goes
	 * through the composer's own handler so attachments and large-text gating
	 * still apply.
	 *
	 * Capture phase on the window: by the time a bubble-phase listener runs, a
	 * focused element has already acted on the key.
	 */
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			redirectKeyToComposer(event);
		};
		const onPaste = (event: ClipboardEvent): void => {
			redirectPasteToComposer(event);
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("paste", onPaste, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("paste", onPaste, true);
		};
	}, []);
	// Jump requests (message tree / trajectory / canvas / branch bar): the
	// Transcript owns window expansion — a jump into the folded window
	// mounts the target row first, then scrolls + flashes (previously the
	// raw querySelector missed unmounted rows and fell back to scrollTop 0).
	const [jumpRequest, setJumpRequest] = useState<{ entryId: string; nonce: number } | null>(null);
	const jumpNonceRef = useRef(0);
	// requestJump is defined further down (after loadOlder — the TurnRail may
	// target a turn above the loaded window, so a jump pages older chunks in
	// first; see the callback below the paging helper).
	// Session-switch reveal: when the active session changes, the transcript
	// rows play a staggered fade-in (逐字错峰) so the context swap reads as a
	// transition instead of a hard cut. The marker is removed after the
	// animation so streaming updates re-render normally.
	//
	// Entering a session always lands on the LATEST message round (TUI
	// resume parity): the .gui-transcript element is reused across sessions
	// (no remount), so its scrollTop and the Transcript's bottom-lock ref
	// would otherwise leak from the previous session — a stale mid-history
	// position on every switch. Jump the scroller to the tail here; the
	// programmatic scroll fires the Transcript's scroll listener, which
	// re-arms the bottom lock so follow-up streaming stays pinned.
	useEffect(() => {
		if (!store) return;
		const el = transcriptRef.current;
		if (el) {
			el.dataset.switched = "1";
			el.scrollTop = el.scrollHeight;
		}
		// #12: the revert dock is session state — its undo target (fromLeafKey)
		// belongs to the PREVIOUS session, and acting on it in the new session
		// sends a foreign node id to session.branchAt ("branch failed"). Clear
		// it on every session switch.
		setJumpBack(null);
		setJumpDockOpen(false);
		// Leaf pin + daemon path pin + map/chat view mode are session state
		// too: the component is REUSED across sessions (no remount), and a
		// foreign session's pins leaked into the new session (its transcript
		// filtered by the old session's path / the map view stuck on).
		setCurrentLeafKey(null);
		setPinnedPathIds(null);
		setViewModeState("chat");
		// Secret cards belong to the session that raised them — leaving the
		// session drops the card; the daemon replays it on return.
		setSecretRequests([]);
		answeredSecretRequestsRef.current.clear();
		const timer = setTimeout(() => {
			if (el) delete el.dataset.switched;
		}, 700);
		return () => clearTimeout(timer);
	}, [store?.sessionId, store]);
	// Quote chips retain their source entry so a later card can jump back to it.
	const [quotes, setQuotes] = useState<DisplayContext[]>([]);
	const appendQuote = useCallback(
		(text: string, messageId?: string, comment?: string, anchor?: ChatQuoteAnchor): void => {
			const normalizedComment = comment?.trim() || undefined;
			setQuotes(current => {
				// Same text at a different spot in the message is a different
				// quote: the anchor's capture offset tells the two apart.
				const sameSpot = (existing: ChatQuoteAnchor | undefined): boolean =>
					(existing?.text ?? "") === (anchor?.text ?? "") && (existing?.start ?? 0) === (anchor?.start ?? 0);
				if (
					current.some(
						context =>
							context.kind === "chat-quote" &&
							context.quote === text &&
							(context.comment ?? "") === (normalizedComment ?? "") &&
							(!anchor || (context.messageId === messageId && sameSpot(context.anchor))),
					)
				)
					return current;
				return [...current, createChatQuoteContext({ messageId, quote: text, comment: normalizedComment, anchor })];
			});
		},
		[],
	);
	// Global Cmd+L (app.tsx) lands here through the shared window event.
	useEffect(() => {
		const onQuoteAppend = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string; messageId?: string; displayContext?: DisplayContext }>)
				.detail;
			if (detail?.displayContext) setQuotes(current => [...current, detail.displayContext!]);
			else if (detail?.text) appendQuote(detail.text, detail.messageId);
		};
		window.addEventListener("musepi-gui-quote-append", onQuoteAppend);
		return () => window.removeEventListener("musepi-gui-quote-append", onQuoteAppend);
	}, [appendQuote]);
	// File-reveal requests from transcript paths / artifact cards: relayed
	// into the ContextPanel → FilePane preview. nonce re-triggers the same
	// path (re-click while already open).
	const [openFileReq, setOpenFileReq] = useState<{
		path: string;
		nonce: number;
		pdf?: PdfQuoteAnchor;
		quote?: string;
		line?: number;
		column?: number;
		pin?: boolean;
	} | null>(null);
	// External browser reveal (chat link click → managed browser, proma
	// AgentBrowserLinkProvider parity). nonce re-triggers the same URL.
	const [openBrowserReq, setOpenBrowserReq] = useState<{ url: string; nonce: number } | null>(null);
	// Active right-panel view — TAB-PRIMARY (supersedes the "single navigation axis" model): one panel-level
	// tab strip hosts every open surface, and the rail opens-or-focuses tabs
	// instead of swapping the panel body. `activeView` is DERIVED from the
	// active tab's surface so every existing setActiveView call site keeps its
	// exact meaning — it now upserts a tab rather than mutating one variable.
	// Welcome scene has no session, so its tab set is keyed by the selected
	// project: workspace tabs (files / git / notes / browser) belong to the
	// directory, not to the session that will be created from it.
	const panelTabs = usePanelTabs(`musepi-gui-panel-tabs-${store?.sessionId ?? store?.cwd ?? project ?? ""}`);
	const activePanelTab = panelTabs.tabs.find(t => t.id === panelTabs.activeId) ?? null;
	const activeView = activePanelTab?.surface ?? null;
	// Surfaces with open tabs — feeds the rail's has-content fallback so a
	// has-content surface stays visible while it has open tabs.
	const openSurfaces = useMemo(() => new Set(panelTabs.tabs.map(tab => tab.surface)), [panelTabs.tabs]);
	// Layer-1 session-tree leaf: null = follow the tip (linear session);
	// a branchAt / branch switch sets it to a historical node so sending
	// forks a new branch under it (TUI navigateTree parity). "root" pins the
	// view to the session ROOT (rewind of the FIRST user message — the active
	// path is empty); a bare string is safe because view keys are
	// `role:timestamp` and never collide with the sentinel.
	const [currentLeafKey, setCurrentLeafKey] = useState<string | "root" | null>(null);
	// Daemon-shipped active path (session.branchAt response / session_leaf_moved
	// broadcast `path`): a fallback id set for transcript filtering when the
	// local parentId walk is CUT (root above the loaded tail window — a rewind
	// target far above the tail used to leave the whole transcript unfiltered,
	// showing the rewound-away tail). null = no pin (walk decides).
	const [pinnedPathIds, setPinnedPathIds] = useState<ReadonlySet<string> | null>(null);
	// Layer-3: 聊天表面顶层 Chat | Canvas 切换(canvas = 会话树地图)。
	// startTransition:画布/对话互切是整树 mount/unmount(超长会话上万
	// 节点),可中断渲染让切换按钮与滚动先行响应,避免"点了没反应"的卡顿感。
	const [viewMode, setViewModeState] = useState<"chat" | "canvas">("chat");
	const setViewMode = useCallback((mode: "chat" | "canvas") => {
		startTransition(() => setViewModeState(mode));
	}, []);
	// 地图单一投影:轮级(节点 = 轮,164 轮 = 164 张卡)。
	// 消息级画布(SessionTreeCanvas)已下线:两套同数据源视图收敛为一个轮级
	// 地图,消息级分支结构由 ContextPanel 的 TrajectoryView 分支树模式承担。
	// Extension panel-tab slots (panel.tab.*) — launchable items live in the
	// rail; the panel also mounts tool- and session-provided on-demand tabs.
	const extTabs = useSlotComponentsByPrefix(rpc, PANEL_TAB_SLOT_PREFIX);
	// Declared AFTER extTabs: its dependency array reads extTabs, and that
	// array is evaluated during render (a TDZ reference would crash here).
	// extTabs feeds the tab-label lookup only. Keep it in a ref so
	// setActiveView's identity stays stable: ContextPanel's reveal effects
	// depend on that callback, and an unstable identity made the browser
	// reveal re-fire on EVERY render (browserOpenRequest is sticky — it is
	// never cleared — so the panel was yanked back to the browser tab
	// continuously, which read as "the + button does nothing").
	const extTabsRef = useRef(extTabs);
	extTabsRef.current = extTabs;
	// Strip label: registry display name for built-ins, the slot's own label for
	// extension tabs — a raw surface id like "ext:settings" must never reach a
	// tab title. Shared by every path that opens a rail surface.
	const tabLabelFor = useCallback((view: string): string => {
		const ext = view.startsWith("ext:") ? extTabsRef.current.find(x => `ext:${x.slot}` === view) : undefined;
		return ext ? (ext.label ?? ext.slot) : t((surfaceById(view)?.label ?? view) as TranslationKey);
	}, []);
	const openBrowserPanel = useCallback(
		(forceNew = false): void => openChatViewBrowserPanel(panelTabs, store?.sessionId ?? null, forceNew),
		[panelTabs, store?.sessionId],
	);
	// Session-list "Open to the Side": the row cannot reach the chat surface's
	// panel-tab state, so it posts an address and this surface owns the tab.
	// The same session is one tab (dedupeKey = session id); opening the active
	// session is a no-op — it is already the main chat.
	useEffect(() => {
		const onOpenSide = (event: Event): void => {
			const detail = (event as CustomEvent<{ sessionId?: unknown; label?: unknown; readOnly?: unknown }>).detail;
			const sessionId = typeof detail?.sessionId === "string" ? detail.sessionId : null;
			if (!sessionId || sessionId === store?.sessionId) return;
			const label =
				typeof detail?.label === "string" && detail.label.trim() ? detail.label : t("general.sideSession");
			panelTabs.open({
				surface: "session",
				target: sessionId,
				dedupeKey: sessionId,
				label,
				readOnly: detail?.readOnly === true,
			});
			if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
		};
		window.addEventListener("musepi-gui-open-session-side", onOpenSide);
		return () => window.removeEventListener("musepi-gui-open-session-side", onOpenSide);
	}, [panelTabs.open, store?.sessionId, rightPanelOpen, focusMode, onExpandRightPanel]);

	// The right panel's shell is one large compiled module. Keeping it mounted
	// while the panel is closed (only so the collapse animates) makes every
	// session open pay for a surface nobody is looking at, so mounting waits for
	// the first open; from then on it stays mounted and the animation is intact.
	const panelShellMounted = useRef(false);
	const panelShellContributions = useSlotComponents(rpc, PANEL_SHELL_SLOT);
	// The right panel reaches its module lazily (the shell mounts on first
	// expand). Import it while the panel is still folded: the module cache makes
	// the mount-time import a hit, so the first click opens the panel in the
	// same frame instead of waiting for the fetch (which also stranded the
	// click that arrived during the load).
	useEffect(() => {
		preloadSlotModules(panelShellContributions);
	}, [panelShellContributions]);
	if ((rightPanelOpen && !focusMode) || panelShellMounted.current) panelShellMounted.current = true;

	const setActiveView = useCallback(
		(view: string | null): void => {
			// null = "nothing selected"; the empty state owns that, the rail and
			// the strip never navigate to it.
			if (!view) return;
			// Session-scoped surfaces read the session snapshot; opening one with
			// no session paints a placeholder. The rail and empty state gate them,
			// this guards the shortcut / request paths that land here directly.
			const target = surfaceById(view);
			if (target && surfaceRequiresSession(target) && !store?.sessionId) return;
			if (view === "browser") {
				openBrowserPanel();
				return;
			}
			if (view === FILE_WORKSPACE_SURFACE && !selectPanelTabComponent(extTabsRef.current, view)) return;
			panelTabs.open({ surface: view, label: tabLabelFor(view) });
		},
		[openBrowserPanel, panelTabs.open, tabLabelFor, store?.sessionId],
	);
	// The capsule's tab: one per session, opened in the right panel. Clicking
	// while it is the visible tab folds the panel (the rail's own rule) instead
	// of leaving the user on a tab they just asked to close.
	const agentInfoTabOpen =
		activePanelTab?.surface === AGENT_INFO_SURFACE && activePanelTab.target === (store?.sessionId ?? null);
	const agentInfoExpanded = agentInfoTabOpen && rightPanelOpen && !focusMode;
	const toggleAgentInfo = useCallback((): void => {
		const sessionId = store?.sessionId;
		if (!sessionId) return;
		if (agentInfoExpanded && onToggleRightPanel) {
			onToggleRightPanel();
			return;
		}
		panelTabs.open(sessionAgentTabDescriptor(sessionId, tabLabelFor(AGENT_INFO_SURFACE)));
		if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
	}, [
		agentInfoExpanded,
		store?.sessionId,
		onToggleRightPanel,
		panelTabs.open,
		tabLabelFor,
		rightPanelOpen,
		focusMode,
		onExpandRightPanel,
	]);
	// The agent info tab's approvals row is a jump, not a second decision
	// surface: it brings the chat's approval card into view and focuses its
	// first action.
	useEffect(() => {
		const onFocusApprovals = (): void => {
			const card = document.querySelector<HTMLElement>(".gui-approval-wrap");
			if (!card) return;
			card.scrollIntoView({ block: "nearest" });
			card.querySelector<HTMLElement>("button")?.focus();
		};
		window.addEventListener("musepi-gui-focus-approvals", onFocusApprovals);
		return () => window.removeEventListener("musepi-gui-focus-approvals", onFocusApprovals);
	}, []);
	const openCompaction = useCallback(
		(entry: Extract<SessionEntry, { type: "compaction" }>): void => {
			if (!extTabsRef.current.some(item => `ext:${item.slot}` === COMPACTION_PANEL_SURFACE)) {
				pushActionToast({ kind: "error", message: t("transcript.compactionSummaryUnavailable") });
				return;
			}
			panelTabs.open(compactionTabDescriptor(entry.id, tabLabelFor(COMPACTION_PANEL_SURFACE)));
			if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
		},
		[panelTabs.open, tabLabelFor, rightPanelOpen, focusMode, onExpandRightPanel],
	);
	const toolPanelRequests = useRef<{
		store: GuiSessionStore | null;
		baseline: boolean;
		seen: Set<string>;
	}>({ store: null, baseline: false, seen: new Set() });
	useEffect(() => {
		const state = toolPanelRequests.current;
		if (state.store !== store) {
			state.store = store;
			state.baseline = false;
			state.seen.clear();
		}
		const requests = (snap?.entries ?? []).flatMap(entry => {
			const descriptor = toolPanelTabDescriptor(entry);
			return descriptor ? [{ id: entry.id, descriptor }] : [];
		});
		if (!state.baseline) {
			state.baseline = true;
			for (const request of requests) state.seen.add(request.id);
			return;
		}
		for (const request of requests) {
			if (state.seen.has(request.id)) continue;
			if (!extTabsRef.current.some(item => `ext:${item.slot}` === request.descriptor.surface)) continue;
			state.seen.add(request.id);
			panelTabs.open(request.descriptor);
			if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
		}
	}, [store, snap?.entries, panelTabs.open, rightPanelOpen, focusMode, onExpandRightPanel]);
	// conversation.chat.node seat dispatch: extensions register renderers for specific
	// node kinds (transcriptNodeKind). A matched renderer OWNS the entry's
	// rendering (may include the built-in children base or render fully custom);
	// (may include the built-in children base or render fully custom);
	// unregistered kinds fall through to the built-in.
	// Memoized: the identity is part of EntryRow's memo comparison, and the
	// component set changes only on extensions.changed — not on stream frames.
	const transcriptNodeComponents = useSlotComponents(rpc, CONVERSATION_CHAT_NODE_SLOT);
	const renderTranscriptNode = useCallback(
		(node: TranscriptNodeInjection) => {
			const selected = selectTranscriptNodeComponents(transcriptNodeComponents, node.kind);
			if (selected.length === 0) return node.children;
			return (
				<>
					{selected.map(item => (
						<SlotComponentMount
							key={`${item.extensionId}:${item.slot}`}
							item={item}
							rpc={rpc}
							sessionId={store?.sessionId ?? null}
							cwd={store?.cwd ?? undefined}
							node={node}
						/>
					))}
				</>
			);
		},
		[transcriptNodeComponents, rpc, store?.sessionId, store?.cwd],
	);
	useEffect(() => {
		const onOpenFile = (ev: Event): void => {
			const detail = (
				ev as CustomEvent<{
					path?: string;
					pdf?: PdfQuoteAnchor;
					office?: OfficeQuoteAnchor;
					quote?: string;
					line?: number;
					column?: number;
					pin?: boolean;
				}>
			).detail;
			const path = detail?.path;
			if (typeof path !== "string" || !path) return;
			const line =
				typeof detail.line === "number" && Number.isInteger(detail.line) && detail.line > 0
					? detail.line
					: undefined;
			const column =
				typeof detail.column === "number" && Number.isInteger(detail.column) && detail.column > 0
					? detail.column
					: undefined;
			setOpenFileReq(prev => ({
				path,
				nonce: (prev?.nonce ?? 0) + 1,
				...(detail.pdf ? { pdf: detail.pdf } : {}),
				...(detail.office ? { office: detail.office } : {}),
				...(detail.quote ? { quote: detail.quote } : {}),
				...(line ? { line, ...(column ? { column } : {}) } : {}),
				...(detail.pin === true ? { pin: true } : {}),
			}));
			onOpenFileInPanel?.(path);
		};
		window.addEventListener("musepi-open-file", onOpenFile);
		return () => window.removeEventListener("musepi-open-file", onOpenFile);
	}, [onOpenFileInPanel]);
	// External browser reveal (chat link click → managed browser).
	useEffect(() => {
		const onOpenUrl = (ev: Event): void => {
			const detail = (ev as CustomEvent<{ url?: string }>).detail;
			const url = detail?.url;
			if (typeof url !== "string" || !url) return;
			setOpenBrowserReq(prev => ({ url, nonce: (prev?.nonce ?? 0) + 1 }));
		};
		window.addEventListener("musepi-open-url", onOpenUrl);
		return () => window.removeEventListener("musepi-open-url", onOpenUrl);
	}, []);
	// ⌘1..8 surface jump: App turns the digit into a select request; the
	// nonce bump re-fires even when the same surface is requested twice.
	// Selecting while collapsed expands the panel (rail-click parity).
	useEffect(() => {
		if (!panelSelectRequest?.id) return;
		setActiveView(panelSelectRequest.id);
		if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [panelSelectRequest?.nonce]);
	// `knowledge` show: the tool asked to put a plan in front of the user. The
	// request is stashed here (nonce-bumped) and consumed by NotesPane, which
	// opens the plan once its list has loaded — the rail jump alone cannot open
	// a plan whose row does not exist yet.
	const [planShowRequest, setPlanShowRequest] = useState<{
		directory: string;
		id: string;
		title: string;
		nonce: number;
	} | null>(null);
	useEffect(() => {
		const onOpenPlan = (ev: Event): void => {
			const detail = (ev as CustomEvent<{ directory?: string; id?: string; title?: string }>).detail;
			const id = detail?.id;
			const directory = detail?.directory;
			if (typeof id !== "string" || !id || typeof directory !== "string" || !directory) return;
			setPlanShowRequest(prev => ({
				directory,
				id,
				title: detail.title ?? "",
				nonce: (prev?.nonce ?? 0) + 1,
			}));
			// The panel only renders the project-knowledge surface, so opening a
			// plan always means opening that surface first.
			setActiveView("notes");
			if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
		};
		window.addEventListener("musepi-open-plan", onOpenPlan);
		return () => window.removeEventListener("musepi-open-plan", onOpenPlan);
	}, [setActiveView, rightPanelOpen, focusMode, onExpandRightPanel]);
	// Tree-path transcript pulse (TUI parity): branchAt / revertTo /
	// forkAt / btwBranch all mutate the CURRENT session's message flow
	// without a sessionId change, so the session-switch effect below (keyed
	// on store?.sessionId) never fires — the transcript would hard-cut.
	// This helper replays the same staggered reveal + tail-jump on demand.
	const pulseSwitch = useCallback((): void => {
		const el = transcriptRef.current;
		if (!el) return;
		el.dataset.switched = "1";
		el.scrollTop = el.scrollHeight;
		window.setTimeout(() => {
			delete el.dataset.switched;
		}, 700);
	}, []);
	// Jump-back (TUI navigateTree parity, 2026-08-25): 撤回 means branchAt,
	// NOT a truncation — the session leaf moves IN PLACE to the target
	// message, the old reply + tail stay reachable as a sibling branch on
	// the tree (natural undo, no daemon backup state; the tree is the
	// single source of truth). The composer gets the message text back for
	// editing, and the dock card above the composer shows the jump target
	// with an explicit undo (jump back to the leaf we came from).
	const [jumpBack, setJumpBack] = useState<{ fromLeafKey: string; text: string } | null>(null);
	const [jumpDockOpen, setJumpDockOpen] = useState(false);
	// Any new prompt after a jump-back commits the new branch — the undo
	// window closes (both branches stay on the tree).
	const sendAndCloseJump = useCallback(
		(
			text: string,
			images?: { type: "image"; data: string; mimeType: string }[],
			deliverAs?: "prompt" | "steer" | "followUp",
			displayContext?: MessageDisplayContext,
			videos?: { type: "video"; mimeType: string; url?: string; data?: string }[],
		): void => {
			// Branch parent BEFORE the leaf is dropped: the optimistic echo is
			// otherwise parentless, `walkLeafPath` treats the tail as a cut chain
			// and the transcript falls back to showing every sibling branch the
			// rewind just left behind.
			const entries = snap?.entries ?? [];
			const last = entries[entries.length - 1] as { id?: unknown } | undefined;
			const parentId =
				currentLeafKey === "root" ? null : (currentLeafKey ?? (typeof last?.id === "string" ? last.id : null));
			setJumpBack(null);
			// Sending from a branch point commits it: drop the explicit leaf so
			// the view follows the new tip. Without this the transcript filter
			// (visibleEntries, anchored on the leaf) would hide the very answer
			// the send just produced.
			//
			// This also hands authority BACK to the local walk. After a withdraw
			// the daemon's post-move path is authoritative and decides the
			// transcript; keeping it past this send would keep filtering the
			// transcript by a path that predates the new prompt and hide the
			// fresh answer. The daemon will broadcast the new path when the run
			// starts; until then the walk follows the optimistic echo (which is
			// parented to `parentId` for exactly this reason).
			setCurrentLeafKey(null);
			setPinnedPathIds(null);
			onSend(text, images, deliverAs, displayContext, videos, parentId);
		},
		[onSend, snap?.entries, currentLeafKey],
	);
	// 保存为图片 → the export dialog (options + live preview) owns the
	// rasterization; the transcript row's save button just opens it.
	const [saveImageText, setSaveImageText] = useState<string | null>(null);
	const [artifactPreview, setArtifactPreview] = useState<SessionArtifactPreviewRequest | null>(null);
	useEffect(() => setArtifactPreview(null), [store]);

	/**
	 * Move the session leaf to `messageId` (TUI navigateTree parity). The old
	 * tail stays on the tree as a sibling branch — nothing is truncated.
	 *
	 * Returns whether the branch actually moved. Both failure shapes are
	 * reported: the daemon THROWS on an unknown message / unactivatable
	 * session, and answers `{ok:false}` when navigateTree cancels. Swallowing
	 * either left the action buttons looking dead — the user clicks 撤回/编辑,
	 * nothing moves, and no reason is shown (the same silent-failure class as
	 * the CSP-blocked copy button).
	 */
	const jumpBackToMessage = async (messageId: string, text: string): Promise<boolean> => {
		if (!store) return false;
		// Kimi parity: undo restores the prompt AND its pictures. The entry is
		// the source; an off-window message still restores the text it carries.
		const images = userMessageImages(snap?.entries.find(entry => entry.id === messageId));
		const fromLeafKey = effectiveLeaf;
		try {
			const res = await rpc.request<{
				ok: boolean;
				leafId: string | null;
				path?: string[];
			}>("session.branchAt", {
				sessionId: store.sessionId,
				messageId,
			});
			if (res?.ok !== true) {
				// Route through the shared in-app banner: an OS notification is
				// easy to miss and leaves the click looking like a no-op.
				window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("general.branchFailed") }));
				return false;
			}
			// null leafId = landed on the session ROOT (rewound past the first
			// user message). Pin explicitly — null means "follow the tip" and
			// would resurrect the tail we just dropped.
			setCurrentLeafKey(res.leafId ?? "root");
			// Daemon-shipped active path (additive contract): anchors the
			// transcript filter even when the walk from the leaf is cut by
			// the tail window (long-session rewind).
			if (Array.isArray(res.path)) setPinnedPathIds(new Set(res.path));
			if (text || images.length > 0) {
				setPendingEdit({ text, ...(images.length > 0 ? { images } : {}) });
			}
			setJumpBack(fromLeafKey ? { fromLeafKey, text } : null);
			pulseSwitch();
			return true;
		} catch (err) {
			const reason = `${t("general.branchFailed")}: ${err instanceof Error ? err.message : String(err)}`;
			window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: reason }));
			return false;
		}
	};
	// Undo the jump-back: branchAt back to the leaf we came from (the
	// sibling branch — nothing was ever truncated).
	const undoJumpBack = async (): Promise<void> => {
		if (!store || !jumpBack) return;
		try {
			const res = await rpc.request<{
				ok: boolean;
				leafId: string | null;
				path?: string[];
			}>("session.branchAt", {
				sessionId: store.sessionId,
				messageId: jumpBack.fromLeafKey,
			});
			if (res?.ok !== true) return;
			// Restored to the session TIP = nothing is pinned anymore: keep the
			// explicit leaf and the breadcrumb would resurrect the rewind view
			// on the next render cycle (nav showed a stale path after undo).
			const entries = store.getSnapshot().entries;
			const last = entries[entries.length - 1];
			const tipId = last && typeof last === "object" ? (last as { id?: unknown }).id : undefined;
			if (!res.leafId || res.leafId === tipId) {
				setCurrentLeafKey(null);
				setPinnedPathIds(null);
			} else {
				if (res.leafId) setCurrentLeafKey(res.leafId);
				if (Array.isArray(res.path)) setPinnedPathIds(new Set(res.path));
			}
			setJumpBack(null);
			pulseSwitch();
		} catch {
			// daemon rejected — keep as-is
		}
	};
	// Map 重答 (branchTo): branch to the turn's user message and backfill the
	// draft — the composer re-send re-answers it (TUI navigateTree parity,
	// 2026-08-24). session.branchAt moves the session leaf IN PLACE — the old
	// reply and any later tail stay on the tree as a sibling branch (NOT
	// truncated like revertTo, NOT copied like forkAt). The transcript ↻
	// retry no longer goes through here: it regenerates the assistant reply
	// in place via session.regenerateAt (no user text re-send, 2026-10-01).
	const branchTo = useCallback(
		async (
			messageId: string,
			/** Pin the transcript to THIS node instead of the daemon's returned
			 *  leaf. session.branchAt maps a USER message to its parent (the
			 *  message is re-answered by the next send), so navigation that
			 *  follows the returned leaf landed on the parent and the
			 *  active-path filter collapsed the transcript onto the branch
			 *  divider — "clicking a sibling made everything disappear". */
			pinTo?: string,
		): Promise<{ leafId: string | null; editorText: string | null } | null> => {
			if (!store) return null;
			try {
				const res = await rpc.request<{
					ok: boolean;
					leafId: string | null;
					editorText: string | null;
					path?: string[];
				}>("session.branchAt", { sessionId: store.sessionId, messageId });
				if (res?.ok !== true) return null;
				const pinned = pinTo ?? res.leafId;
				if (pinned) setCurrentLeafKey(pinned);
				// Display path = daemon's active path, extended through the node
				// we pinned when they differ (branchAt lands a USER message on
				// its parent — the transcript must still show the clicked node).
				if (Array.isArray(res.path)) {
					setPinnedPathIds(new Set(pinTo ? [...res.path, pinTo] : res.path));
				}
				pulseSwitch();
				return { leafId: res.leafId ?? null, editorText: res.editorText ?? null };
			} catch {
				return null;
			}
		},
		[rpc, store],
	);
	const { confirm } = useConfirm();
	// Tree mutation while the agent runs (user report 2026-09-16): retrying from a
	// non-tip node re-anchors the pinned leaf under the in-flight run, and the
	// fresh reply was appended under the WRONG node. All four mutation entries
	// (retry / rewind / switchBranch / switchToNode) confirm + stop the run first;
	// pure navigation (jump) stays free.
	// Async handlers must read the LATEST working flag: the closure's `snap`
	// is frozen at render time, so a stop issued a moment ago would still
	// look running (or vice versa) while waiting to re-branch.
	const snapRef = useRef(snap);
	snapRef.current = snap;
	const waitWorkingCleared = useCallback(
		(timeoutMs = 6000): Promise<void> =>
			new Promise(resolve => {
				// Event-driven: the store emits on every applied daemon frame, so the
				// stop unwinds within ONE emission. Polling would busy-wait between
				// frames and still lag an emission behind (user preference: no
				// polling unless necessary). The timeout only guards a stuck run.
				let unsub: (() => void) | undefined;
				const done = (): void => {
					unsub?.();
					clearTimeout(timer);
					resolve();
				};
				const check = (): void => {
					if (store?.getSnapshot().working !== true) done();
				};
				const timer = setTimeout(done, timeoutMs);
				unsub = store?.subscribe(check);
				check();
			}),
		[store],
	);
	const confirmTreeOpWhileWorking = useCallback(async (): Promise<boolean> => {
		if (snap?.working !== true) return true;
		return confirm(
			`${t("general.agentRunning")}\n\n${t("general.treeOpInterruptsWork")}`,
			t("general.interruptContinue"),
		);
	}, [confirm, snap?.working, t]);
	// Fork is the one tree op that does NOT stop the run: the daemon snapshots
	// history at the current turn's start and the source keeps streaming.
	// Confirm only explains the snapshot boundary, so a user expecting the
	// in-flight reply can cancel instead of losing it. Returns false = cancelled.
	const confirmForkWhileWorking = useCallback(async (): Promise<boolean> => {
		if (snap?.working !== true) return true;
		return confirm(
			`${t("general.agentRunning")}\n\n${t("general.forkSnapshotHint")}`,
			t("general.continuePointNewSession"),
		);
	}, [confirm, snap?.working, t]);
	// 统一树操作守卫(retry / rewind / switchBranch 共用):运行中先
	// 确认,确认后停下在途回合并等它真正收敛(branchAt 在在途回合下重锚
	// 会把回复挂错节点,2026-09-16 用户报告)。纯导航(jump)不走此守卫。
	// 返回 false = 用户取消了确认(操作未执行)。
	const runTreeOp = useCallback(
		async (op: () => unknown, opts?: { confirmed?: boolean }): Promise<boolean> => {
			// `confirmed`: the caller already asked its own question, which named
			// this very operation (withdrawSettled). Asking again here stacked a
			// generic "interrupt the run?" under the named one.
			if (!opts?.confirmed && !(await confirmTreeOpWhileWorking())) return false;
			if (snapRef.current?.working) onStop();
			await waitWorkingCleared();
			await op();
			return true;
		},
		[confirmTreeOpWhileWorking, onStop, waitWorkingCleared],
	);
	// Regenerate (重试, the ↻ action under an ASSISTANT reply): truncate to
	// just before the reply and re-run the agent from there — session.regenerateAt
	// moves the leaf to the reply's parent (the old reply and its tail stay on
	// the tree as a sibling branch, nothing truncated) and schedules a fresh
	// agent run WITHOUT re-sending user text. The old flow branched to the
	// producing USER message and re-sent it, which duplicated the turn in the
	// model context and bumped the turn count (user report 2026-10-01).
	const regenerateFromAssistant = async (messageId: string): Promise<void> => {
		if (!store) return;
		await runTreeOp(async () => {
			try {
				const res = await rpc.request<{ ok: boolean; leafId: string | null; path?: string[] }>(
					"session.regenerateAt",
					{ sessionId: store.sessionId, messageId },
				);
				if (res?.ok !== true) {
					window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("general.branchFailed") }));
					return;
				}
				// Follow the fresh tip: the regenerated reply streams in as a new
				// sibling under the truncated node — the same follow-the-send
				// contract as the composer path.
				setCurrentLeafKey(null);
				setPinnedPathIds(null);
				pulseSwitch();
			} catch (err) {
				const reason = `${t("general.branchFailed")}: ${err instanceof Error ? err.message : String(err)}`;
				window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: reason }));
			}
		});
	};
	/** One-line excerpt of the turn being withdrawn — the dialog must name the
	 *  turn, not describe an anonymous action. The full message is quoted in the
	 *  body below it; this is the title's recognition anchor. */
	const withdrawExcerpt = (text: string): string => {
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
	};
	/** The ONE question every leaf-moving undo asks (撤回 / 编辑并重发 / 地图与
	 *  面板的重答): the turn moves to a side branch, nothing is deleted, what
	 *  the user can do next. `quote` is the turn's prompt as they wrote it; a
	 *  tree node whose content the client could not read gets the generic "an
	 *  earlier turn" — naming an empty turn would be a false statement, not a
	 *  neutral one. A running turn is named in the same dialog: the leaf cannot
	 *  move under the run, so the question also has to say it will be stopped.
	 *  Not the bare "are you sure": the action looks destructive and is not. */
	const confirmWithdraw = async (quote: string, busy: boolean): Promise<boolean> => {
		const flat = quote.replace(/\s+/g, " ").trim();
		const named = flat ? `“${withdrawExcerpt(flat)}”` : t("general.withdrawConfirmEarlierTurn");
		const body = [
			flat ? `“${flat}”` : "",
			t("general.withdrawConfirm"),
			busy ? t("general.withdrawConfirmBusy") : "",
		];
		return confirm(`${named}\n\n${body.filter(Boolean).join("\n\n")}`, t("general.withdrawConfirmAction"));
	};
	/** Order matters: name the turn WHILE the run still stands, then stop it. The
	 *  interrupt guard used to fire first, so a working-run withdraw asked twice
	 *  (interrupt? then withdraw?) and, read backwards, told the user the run
	 *  was being interrupted before they had decided to interrupt it.
	 *
	 *  `confirmed: true` is what makes the named question the ONLY one: the
	 *  guard would otherwise ask its own generic "interrupt the run?" right
	 *  after the user answered this one. The stop itself still happens here,
	 *  after the answer — the confirmation only owns the question. */
	const withdrawSettled = async (quote: string, op: () => Promise<unknown>): Promise<boolean> => {
		if (!(await confirmWithdraw(quote, snapRef.current?.working === true))) return false;
		await runTreeOp(op, { confirmed: true });
		return true;
	};
	// Rewind (撤回, the ⤺ action under a USER message): branch to the user
	// message's PARENT — the node BEFORE it — so the user message itself also
	// drops out of the active path (user-reported semantics, 2026-09-15).
	// Distinct from onEdit, which keeps the node and backfills its text, and
	// from retry, which keeps the node and re-answers it. The dropped tail
	// stays on the tree (map/trajectory) as a sibling branch; nothing is
	// truncated.
	//
	// EVERY 撤回 entry point funnels here — the transcript row button, the
	// message-tree panel row, the panel's turn re-answer and the map's — so this
	// is the one place the confirmation belongs. Cancelling returns before any
	// RPC, so the leaf cannot move; a running turn is named in the same dialog
	// (confirmWithdraw) instead of a second interrupt question.
	const rewindFromUserMessage = async (messageId: string, text: string): Promise<void> => {
		if (!store) return;
		// Converged path: branchAt AFTER the run actually unwinds (runTreeOp).
		// Hand the message's own id to branchAt: the daemon's user→parent
		// mapping covers rewind-to-root natively. The old entry lookup +
		// null-parentId interception toasted "branch failed" BEFORE the RPC
		// whenever the first user message was rewound.
		//
		// Kimi parity: the reverted prompt goes back into the composer. The
		// transcript passes the message text; an empty one still moves the leaf
		// without touching the draft (structural tree revert).
		await withdrawSettled(text, () => jumpBackToMessage(messageId, text));
	};
	/** Prompt text carried by a user entry (tree/menu revert needs the same
	 *  backfill without the transcript row's quoteText plumbing). */
	const userMessageText = (entry: SessionEntry | undefined): string => {
		if (entry?.type !== "message") return "";
		// `WireMessage` also carries BashExecutionMessage (no content field).
		const content = (entry.message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join(" ");
	};
	/** Image blocks of the same user entry — Kimi restores them together with
	 *  the text on undo, so a re-answer does not silently lose the pictures. */
	const userMessageImages = (entry: SessionEntry | undefined): { type: "image"; data: string; mimeType: string }[] => {
		if (entry?.type !== "message") return [];
		const content = (entry.message as { content?: unknown }).content;
		if (!Array.isArray(content)) return [];
		return content.filter(
			(block): block is { type: "image"; data: string; mimeType: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "image" &&
				typeof (block as { data?: unknown }).data === "string" &&
				typeof (block as { mimeType?: unknown }).mimeType === "string",
		);
	};
	interface PendingComposerEdit {
		text: string;
		images?: { type: "image"; data: string; mimeType: string }[];
	}
	// Pending composer prefill: message text sent back for re-editing
	// (jump-back 回填 + transcript inline edit). null = no pending edit.
	const [pendingEdit, setPendingEdit] = useState<PendingComposerEdit | null>(null);
	// Fork (分叉 / TUI /branch parity): non-destructive — copy the session
	// truncated at this message into a NEW session, open it, and backfill
	// the composer with the message text (the TUI /branch loads the
	// selected message into the editor so the user can re-answer it).
	// `includeTarget` keeps the node as the new session's last record (TUI
	// navigateTree parity for assistant/toolResult nodes — continue from
	// there with a fresh prompt); user messages truncate before the node
	// and re-answer via the backfilled text.
	const forkFromMessage = useCallback(
		async (messageId: string, text?: string, includeTarget?: boolean): Promise<void> => {
			if (!store) return;
			// Fork does NOT stop the source: `snapshot: true` makes the daemon
			// cut at the current turn's start while the run keeps streaming, so
			// the fork is non-destructive even mid-answer.
			if (!(await confirmForkWhileWorking())) return;
			try {
				const res = await rpc.request<{ sessionId: string; parentId: string }>("session.forkAt", {
					sessionId: store.sessionId,
					messageId,
					includeTarget,
					snapshot: true,
				});
				if (res?.sessionId) {
					await onForkSession?.(res.sessionId);
					if (text) setPendingEdit({ text });
				}
			} catch (err) {
				// Concurrent snapshot forks are rejected with a retryable code
				// (the source file is mid-read by another fork); other failures
				// keep the old silent behaviour (unknown message/session).
				if (err instanceof Error && err.message.includes("SESSION_FORK_IN_PROGRESS")) {
					window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("general.forkSnapshotRetry") }));
				}
			}
		},
		[confirmForkWhileWorking, rpc, store, onForkSession],
	);
	// ── Layer-1 session-tree topology (nav unification, 2026-08-24) ────
	// Children index over the view entries by parentId; the active path
	// (breadcrumb + transcript filtering) walks from the leaf up.
	const branchChildren = useMemo(() => {
		const map = new Map<string, { id: string; kind: string }[]>();
		for (const entry of snap?.entries ?? []) {
			const e = entry as { id?: string; parentId?: string | null; type?: string; message?: { role?: string } };
			if (typeof e.id !== "string" || typeof e.parentId !== "string" || !e.parentId) continue;
			// 分叉条只数会话分叉(message);custom 簿记/展示卡保留直接父链,
			// 后 parent 到最近 message 祖先,计入会让每条消息都亮"2 个分支"。
			if (!isBranchFormingEntry(entry as SessionEntry)) continue;
			const bucket = map.get(e.parentId);
			const row = {
				id: e.id,
				kind: e.message?.role ?? "message",
			};
			if (bucket) bucket.push(row);
			else map.set(e.parentId, [row]);
		}
		return map;
		// P1-12: gate on structureRev, not snap.entries — a streaming content
		// upsert replaces the message object but never touches id/parentId, so
		// the topology is unchanged. Deps stay deliberately narrow; sessionId is
		// the other list-shape event (a switch re-seeds entries at rev 0).
	}, [snap?.sessionId, snap?.structureRev]);
	// Current leaf: explicit branch switch wins; otherwise the LAST entry
	// (linear tip). Reset the override whenever the session changes.
	const effectiveLeaf = useMemo(() => {
		// Pinned to the session root (rewound past the first user message):
		// the active path is empty, so there is no leaf to walk from.
		if (currentLeafKey === "root") return null;
		const entries = snap?.entries ?? [];
		const last = entries[entries.length - 1];
		const lastId = typeof last === "object" && last !== null ? (last as { id?: unknown }).id : undefined;
		return currentLeafKey ?? (typeof lastId === "string" ? lastId : null);
		// P1-12: structureRev covers the last entry's identity. The store's
		// optimistic echo appends outside that counter — its row is parentless
		// and always renders, so a stale leaf id for the sub-second echo
		// window is invisible (see session-store.structureRev note).
		// sessionId: the component is reused across sessions and a snapshot-
		// seeded store starts its counter back at 0, so structureRev alone kept
		// the PREVIOUS session's leaf here (and its walk below) — the new
		// transcript was then filtered against the old path, leaving one row.
	}, [currentLeafKey, snap?.sessionId, snap?.structureRev, snap?.entries.length]);
	// Walk root → leaf via parentId (breadcrumb path). `complete` records WHY the
	// walk stopped — at a genuine root (an entry with no parentId — the topology
	// is trustworthy) or on a parentId that is not in the loaded window (the
	// chain is cut). The daemon rewrites SDK hex ids to message keys and clears
	// a link it cannot resolve, so a history session opened fresh can hand us a
	// chain whose start is outside the window — and filtering the transcript
	// against such a partial path dropped nearly every row (user: 打开旧会话只
	// 显示到最开始那条, 会话树也没亮). A parentless entry that is NOT the
	// oldest loaded one is a cut chain too (a role the emitter forgot to stamp),
	// never a trustworthy root — 实机回归: 尾顾问卡 parentId=null 被当真根,
	// 旧消息整批消失。Pure logic lives in lib/leaf-walk.ts (tested there).
	const leafWalk = useMemo(() => {
		// Pinned to the session root: no leaf, so the active path is empty
		// (and trustworthy — nothing is cut).
		if (currentLeafKey === "root") return EMPTY_TRUSTED_WALK;
		return walkLeafPath(snap?.entries ?? [], effectiveLeaf);
		// P1-12: the parentId chain only changes when the entry list shape
		// changes (structureRev); a content upsert preserves parentId on the
		// replacement object. sessionId: a session switch re-seeds the entries
		// with the counter reset to 0, so the walk must be rebuilt with them.
	}, [effectiveLeaf, currentLeafKey, snap?.sessionId, snap?.structureRev]);
	const leafPath = leafWalk.path;
	// Map-mode prompt-rail focus request: the rail is navigation, not a branch
	// change, so it hands the canvas a node to center + highlight.
	const [canvasFocus, setCanvasFocus] = useState<{ id: string; nonce: number } | null>(null);
	// Canvas-mode rail source: the map has no transcript scroller (the rail's
	// normal source is DOM measurement), so it is driven by the ACTIVE PATH —
	// one marker per user message on it, active = the turn the leaf sits in —
	// and a click switches the node instead of scrolling.
	const canvasRail = useMemo(() => {
		const byId = new Map<string, { content?: unknown }>();
		for (const e of snap?.entries ?? []) {
			const id = (e as { id?: unknown }).id;
			const m = (e as { message?: { content?: unknown } }).message;
			if (typeof id === "string" && m) byId.set(id, m);
		}
		const turns: { id: string; summary: string }[] = [];
		let activeIdx: number | null = null;
		for (const p of leafPath) {
			if (p.kind !== "user") continue;
			const content = byId.get(p.id)?.content;
			const blocks = Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>) : [];
			const text =
				typeof content === "string"
					? content
					: blocks
							.filter(b => b?.type === "text")
							.map(b => b.text ?? "")
							.join(" ");
			turns.push({ id: p.id, summary: text.replace(/\s+/g, " ").trim().slice(0, 90) });
			activeIdx = turns.length - 1;
		}
		return { turns, activeIdx };
		// P1-12: the rail iterates the ACTIVE PATH's user turns — user message
		// content is final at insert (assistant messages stream, users don't),
		// so a content upsert can only stale the 90-char summary of a user
		// note, never the turn set. Topology gate is sufficient.
	}, [snap?.structureRev, leafPath]);
	// Active path id set for transcript filtering (off-path entries collapse).
	const activePathIds = useMemo(() => new Set(leafPath.map(p => p.id)), [leafPath]);
	// Path handed to the tree/map/trajectory for dimming. With a cut chain the
	// partial path would dim almost every node (the map's "where am I" anchor
	// and the off-path fade read as "nothing is lit"), so an untrustworthy walk
	// passes nothing and those views fall back to leaf-based highlighting —
	// UNLESS the daemon shipped the active path (session.branchAt response /
	// leaf_moved broadcast): that set is authoritative even when the local
	// chain is cut (long-session rewind), so it wins over passing nothing.
	const trustedPathIds = leafWalk.complete ? activePathIds : (pinnedPathIds ?? undefined);
	// Transcript input: the visible conversation is the ACTIVE PATH only —
	// sibling branches and the tail beyond the leaf stay on the tree (map /
	// trajectory / session tree keep the full list) but leave the transcript.
	// This applies to LINEAR sessions too: the fallback leaf is the last entry,
	// and in a branched session "last appended" is NOT "the branch in view", so
	// skipping the filter on re-entry rendered every sibling at once. Entries
	// without a parent chain (round markers, synthetic rows) always stay: they
	// hang off the session root, not off a branch point.
	//
	// The daemon's post-move path OVERRIDES the walk (user report: 撤回 left the
	// withdrawn turn in the transcript). The walk is only as good as the
	// parentId stamps in the loaded window, and live wire messages may omit
	// them — a tail whose parentIds all read null is indistinguishable from a
	// root run, so `complete` can be true while the path is wrong, and the
	// filter then rendered every sibling including the turn just withdrawn.
	// The branchAt/leaf_moved response is computed daemon-side from the real
	// session tree, so when it is present it IS the active path.
	const visibleEntries = useMemo(
		() =>
			filterVisibleEntries(snap?.entries ?? [], leafWalk, activePathIds, {
				authoritativePathIds: pinnedPathIds ?? undefined,
				pinnedToRoot: currentLeafKey === "root",
			}),
		[snap?.entries, activePathIds, leafWalk, currentLeafKey, pinnedPathIds],
	);
	// 「对话在视」id 集,交给地图/轨迹/消息树判离路径。
	//
	// 这是 M82 遗留 P2 的修法:此前交给地图的是 `trustedPathIds`——walk/pin 的
	// 原始 id 集,不知道 daemon 只回 200 条的窗口边界。于是同一份会话,转录按
	// `filterVisibleEntries` 说「这是历史」,地图按原始集说「这是旁支」:
	// 尾部 parentId 全 null 时整条 live 会话被画成支线,截断 walk + 260 行时
	// 第 1-30 轮(转录照常显示)被涂成离路径。
	//
	// 现在只从**转录自己的输出**投影:转录显示什么,地图就认什么为主线。窗口
	// 规则仍只有一处(`filterVisibleEntries`),地图不再独立理解它。
	const onPathIds = useMemo(
		() => transcriptPathIds(snap?.entries ?? [], visibleEntries),
		[snap?.entries, visibleEntries],
	);
	// The leaf is "historical" when it already has children — sending now
	// would fork a new branch under it.
	const leafChildren = useMemo(() => {
		if (!effectiveLeaf) return [];
		return branchChildren.get(effectiveLeaf) ?? [];
	}, [branchChildren, effectiveLeaf]);
	const labelOf = (entry: { id: string } | undefined, fallback: string): string => {
		if (!entry) return fallback;
		const raw = (snap?.entries ?? []).find(
			e => typeof e === "object" && e !== null && (e as { id?: unknown }).id === entry.id,
		);
		if (!raw || typeof raw !== "object") return fallback;
		const m = (raw as { message?: { content?: unknown } }).message;
		const blocks = Array.isArray(m?.content) ? (m.content as Array<{ type?: string; text?: string }>) : [];
		const text =
			typeof m?.content === "string"
				? m.content
				: blocks
						.filter(b => b?.type === "text")
						.map(b => b.text ?? "")
						.join(" ");
		return text.replace(/\s+/g, " ").trim().slice(0, 60) || fallback;
	};
	const breadcrumb: BreadcrumbSegment[] = useMemo(
		() =>
			leafPath.map((p, i) => ({
				id: p.id,
				kind: (p.kind as "user") === "user" ? "user" : p.kind === "toolResult" ? "toolResult" : "assistant",
				label: labelOf(p, i === 0 ? t("transcript.root") : "…"),
			})),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[leafPath],
	);
	// Deepest node of the branch starting at `id` (newest-child chain). The
	// branch switcher navigates to this TIP, not to the picked node: picking a
	// USER-message sibling would otherwise be re-answered in place (branchAt
	// maps user messages to their parent) and its reply would fall off the
	// active path.
	const branchTipOf = useCallback(
		(id: string): string => {
			let cursor = id;
			const seen = new Set<string>([id]);
			for (;;) {
				const kids = branchChildren.get(cursor);
				const next = kids && kids.length > 0 ? kids[kids.length - 1]?.id : undefined;
				if (!next || seen.has(next)) return cursor;
				seen.add(next);
				cursor = next;
			}
		},
		[branchChildren],
	);
	const switchBranch = useCallback(
		async (childId: string): Promise<void> => {
			// Tree-op guard (runTreeOp, 2026-09-16收口): switchBranch was the
			// one mutation entry left on the raw confirm+stop path with a
			// render-frozen `snap` — the same class of race as retry/rewind.
			// snapRef reads the LATEST working flag inside the guard.
			await runTreeOp(async () => {
				// Jump the transcript to the picked sibling first, then move the
				// session leaf there (branchAt) so continuing forks from it.
				const target = branchTipOf(childId);
				requestJump({ entryId: target });
				setCurrentLeafKey(target);
				await branchTo(target, target);
			});
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[runTreeOp, branchTipOf, branchTo],
	);
	// switchToNode: 统一树节点切换入口(画布双击/面包屑/分支切换)。
	// 对齐 TUI /tree 的 navigateTree 语义——移动到目标 leaf + 滚动 + 回填草稿。
	// 消息树浮窗的行点击不再走这里:那是纯跳转(onJump),不改变 leaf。
	const switchToNode = useCallback(
		async (id: string, opts?: { backfillDraft?: boolean }): Promise<void> => {
			// Tree-op guard (runTreeOp): moving the leaf under an in-flight run
			// re-anchors it — confirm + stop + wait like retry/rewind/fork.
			await runTreeOp(async () => {
				requestJump({ entryId: id });
				// #12: an explicit node switch supersedes the revert dock — its undo
				// target is the leaf we CAME FROM, which this jump just replaced.
				setJumpBack(null);
				// Pin the clicked node itself: branchAt answers a USER message by
				// positioning at its parent, and following that leaf hid the node
				// the user just navigated to.
				const res = await branchTo(id, id);
				// 切换语义可显式关草稿回填(地图「切换到此分支」:纯切分支,
				// 若带着上一轮重答留下的草稿会让输入框停留在旧文本)。
				if (res?.editorText && opts?.backfillDraft !== false) setPendingEdit({ text: res.editorText });
			});
		},
		// P1-12: the entry lookup inside reads id/timestamp — both immutable
		// across content upserts — so structureRev (list shape) is the correct
		// freshness gate, and it keeps this callback stable across streaming
		// frames (it feeds the memo'd canvas cards via onSwitchToBranch). The
		// eslint comment below predates the biome-only setup (biome's
		// useExhaustiveDependencies is off) and is kept for editors running
		// the eslint plugin.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[snap?.structureRev, runTreeOp, branchTo],
	);

	// Lazy history backfill: the transcript fires this
	// when its tail window is fully expanded and the user scrolls up past
	// the oldest loaded entry. Pages the next chunk from session.history
	// (cursor = oldest loaded entry id) and prepends it into the store —
	// the daemon keeps the full transcript, nothing is lost.
	const activeHistoryStoreRef = useRef(store);
	activeHistoryStoreRef.current = store;
	const loadingOlder = snap?.historyLoading === true;
	// Key-based prepend anchoring (Transcript.anchorCtlRef): captured before
	// the session.history RPC, restored after the prepend commits — the old
	// scrollHeight-delta compensation jumped blindly (streaming tail growth
	// and estimate corrections both skew the delta) and triggered
	// measurement-correction cascades.
	const anchorCtlRef = useRef<TranscriptAnchorCtl | null>(null);
	/**
	 * Re-read the transcript from the daemon, so a "no reply" verdict is checked
	 * against fresh state rather than the live stream's view — the stream can drop a
	 * turn's events and leave the prompt as the last entry even though the daemon
	 * answered it.
	 *
	 * Mirrors the session_leaf_moved recovery: fetch a fresh snapshot and swap the
	 * view in place, preserving the store identity so the pinned leaf and the
	 * jump-back dock survive the refresh.
	 */
	const verifyTranscript = useCallback(async (): Promise<void> => {
		if (!rpc || !store) return;
		try {
			const res = await rpc.request<{
				snapshot: {
					entries: unknown[];
					state?: unknown;
					cursor: number;
					roundDurations?: [number, number][];
					tail?: { hasMore: boolean; beforeId: string | null };
				};
			}>("session.resume", { sessionId: store.sessionId });
			store.reloadFromSnapshot({
				entries: res.snapshot.entries as never,
				state: res.snapshot.state as never,
				cursor: res.snapshot.cursor,
				roundDurations: res.snapshot.roundDurations,
				tail: res.snapshot.tail,
			});
		} catch {
			// Daemon restarting, session gone, or an older daemon without the call:
			// the reconnect path re-opens the session. Swallowed on purpose — the dock
			// reads a settled-but-failed check as "still no reply", which is the
			// honest reading of a daemon it could not reach.
		}
	}, [rpc, store]);
	const loadOlder = useCallback(async (): Promise<void> => {
		if (!rpc || !store) return;
		const anchor: TranscriptAnchor | null = anchorCtlRef.current?.capture() ?? null;
		const sessionId = store.sessionId;
		const loaded = await store.loadOlder(beforeId =>
			rpc.request<HistoryPage>("session.history", { sessionId, beforeId, maxMessages: HISTORY_PAGE_MESSAGES }),
		);
		if (!loaded || activeHistoryStoreRef.current !== store) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (anchor && activeHistoryStoreRef.current === store) anchorCtlRef.current?.restore(anchor);
			});
		});
	}, [rpc, store]);
	// Stable identity for the Transcript observer (rebuilding the observer
	// on every render would thrash the IntersectionObserver).
	const onLoadOlderStable = useCallback((): void => {
		void loadOlder();
	}, [loadOlder]);
	// ── ⌘F in-conversation find ────────────────────────────────────────
	// The daemon search is scoped to this session, so it sees the WHOLE
	// conversation rather than only the loaded transcript window; the jump
	// then pages the hit in through the normal transcript path. Hits arrive
	// newest first, so ↑ walks towards the present and ↓ back through history.
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findHits, setFindHits] = useState<readonly FindHit[]>([]);
	const [findIndex, setFindIndex] = useState(-1);
	const [findSearching, setFindSearching] = useState(false);
	const findSessionId = store?.sessionId ?? null;
	// Monotonic request token: a slow reply for an abandoned query must not
	// land on top of a newer one — the debounce alone doesn't order the RPCs.
	const findTokenRef = useRef(0);
	useEffect(() => {
		if (!findOpen) return;
		const token = ++findTokenRef.current;
		const q = findQuery.trim();
		if (!q || !rpc || !findSessionId) {
			setFindHits([]);
			setFindIndex(-1);
			setFindSearching(false);
			return;
		}
		setFindSearching(true);
		const timer = setTimeout(() => {
			void rpc
				.request<{ matches: { timestamp: number; content: string }[] }>("session.search", {
					query: q,
					sessionId: findSessionId,
					limit: 200,
				})
				.then(res => {
					if (token !== findTokenRef.current) return;
					const hits = (res?.matches ?? [])
						.filter(m => typeof m.timestamp === "number" && Number.isFinite(m.timestamp))
						.map(m => ({
							timestampMs: m.timestamp,
							snippet: m.content.trim().slice(0, 160),
						}));
					setFindHits(hits);
					// Land on the first hit straight away: opening find with a query
					// already typed should reveal something.
					setFindIndex(hits.length > 0 ? 0 : -1);
					setFindSearching(false);
				})
				.catch(() => {
					if (token !== findTokenRef.current) return;
					setFindHits([]);
					setFindIndex(-1);
					setFindSearching(false);
				});
		}, 200);
		return () => clearTimeout(timer);
	}, [findOpen, findQuery, rpc, findSessionId]);
	const openFind = useCallback((): void => setFindOpen(true), []);
	const closeFind = useCallback((): void => {
		setFindOpen(false);
		setFindQuery("");
		setFindHits([]);
		setFindIndex(-1);
	}, []);
	// The window-level ⌘F handler (app.tsx) owns the binding so it composes with
	// every other shortcut in one chain; ChatView takes the dispatch.
	useEffect(() => {
		const onOpen = (): void => openFind();
		window.addEventListener("musepi-gui-find-in-chat", onOpen);
		return () => window.removeEventListener("musepi-gui-find-in-chat", onOpen);
	}, [openFind]);
	// Leaving the session (or switching to the canvas overview, which has no
	// transcript to search) must not leave a find bar over a pane it cannot
	// search — its hits would still be the previous session's.
	useEffect(() => {
		if (!findSessionId || viewMode === "canvas") closeFind();
	}, [findSessionId, viewMode, closeFind]);
	const stepFind = useCallback(
		(delta: number): void => {
			setFindIndex(prev => {
				const n = findHits.length;
				if (n === 0) return -1;
				return (Math.max(prev, 0) + delta + n) % n;
			});
		},
		[findHits.length],
	);
	// Jump via requestJumpRef — the single owner of "put this row on screen"
	// (pages older chunks, opens the compaction fold, scrolls the virtualizer,
	// flashes the row). Same path the TurnRail and the canvas use. The
	// indirection exists because requestJump is declared further down (it
	// depends on loadOlder) while this block needs to reach it.
	// The daemon's message table has no wire entry id (P1-17), so a hit
	// arrives as timestamp + text; JumpTarget resolves that against the loaded
	// entries and disambiguates same-millisecond collisions by content.
	const jumpToHit = useCallback((hit: FindHit): void => {
		requestJumpRef.current?.({ timestampMs: hit.timestampMs, snippet: hit.snippet });
	}, []);
	// Reveal the selected hit. Keyed on the selected HIT rather than the
	// query, so typing never yanks the viewport on a keystroke.
	const selectedHit = findIndex >= 0 ? findHits[findIndex] : undefined;
	useEffect(() => {
		if (selectedHit) jumpToHit(selectedHit);
	}, [selectedHit, jumpToHit]);
	// Overview surfaces share the transcript's bounded history window. Older
	// pages arrive only through store.loadOlder (explicit map/trajectory action
	// or a targeted jump), so opening a long session never backfills everything.
	const overviewEntries = (snap?.entries ?? []) as SessionEntry[];
	// 激活路径过滤(概览面):回退/切分支后,时间线/统计只应呈现"当前这条分
	// 支"的轮次——兄弟分支的轮属于树视图(地图/分支树保留全量淡显),不属于
	// 会话在视内容。与 transcript 同一套 leaf-walk 契约;null = 拓扑不可信且
	// 无 daemon 捎带路径 → 概览回退全量(旧行为)。
	const pathEntries = useMemo(
		() =>
			filterVisibleEntries(overviewEntries, leafWalk, activePathIds, {
				// Same authority as the transcript: the daemon's post-move path
				// decides which turns are on the active path, so the rail and the
				// map agree with what the conversation shows.
				authoritativePathIds: pinnedPathIds ?? undefined,
				pinnedToRoot: currentLeafKey === "root",
			}),
		[overviewEntries, leafWalk, activePathIds, currentLeafKey, pinnedPathIds],
	);
	const pathEntriesOrNull = leafWalk.complete || pinnedPathIds ? pathEntries : null;
	// M1.11: data-driven TurnRail source — one lightweight record per turn
	// (~120B). The rail no longer measures turn positions from the DOM: rows
	// outside the transcript's render window don't exist to measure, which is
	// what made the rail drop turns on long sessions.
	//
	// Full-session index (session.turns): the local buildTurnIndex only covers
	// the LOADED window (the daemon tails 200 entries; older chunks page in on
	// scroll), so on a long session the rail silently dropped everything above
	// the paged-in region. The daemon scans the in-memory snapshot once and
	// ships one record per turn regardless of how much history is loaded; the
	// loaded set contributes only turns that arrived AFTER that scan (live
	// streaming), appended in timestamp order.
	const [daemonTurns, setDaemonTurns] = useState<TurnIndexItem[] | null>(null);
	useEffect(() => {
		if (!rpc || !store) {
			setDaemonTurns(null);
			return;
		}
		let cancelled = false;
		rpc.request<{ turns: TurnIndexItem[] }>("session.turns", { sessionId: store.sessionId, limit: 200 })
			.then(res => {
				if (!cancelled) setDaemonTurns(Array.isArray(res?.turns) ? res.turns : null);
			})
			.catch(() => {
				// daemon predates session.turns / session unknown — fall back
				// to the loaded-window index.
				if (!cancelled) setDaemonTurns(null);
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, store]);
	const loadedTurns = useMemo(() => buildTurnIndex(snap?.entries ?? []), [snap?.entries]);
	const railTurns = useMemo(() => {
		if (!daemonTurns) return loadedTurns;
		const byId = new Map(daemonTurns.map(turn => [turn.entryId, turn]));
		for (const turn of loadedTurns) {
			if (!byId.has(turn.entryId)) byId.set(turn.entryId, turn);
		}
		return [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	}, [daemonTurns, loadedTurns]);
	// 分支在视:导航条只标激活路径上的轮次(兄弟分支的轮属于树视图,不在
	// 当前这条会话里)。仅在本地拓扑可信(walk complete)时过滤——那时整条
	// 路径都在加载窗内,过滤不丢轮;pinned 路径是尾窗截断集,按它过滤会把
	// 窗口外更早的路径轮抹掉,而 rail 还肩负全量索引 + 向上翻页的职责。
	const pathTurnIds = useMemo(() => {
		if (!leafWalk.complete || !pathEntriesOrNull) return null;
		const set = new Set<string>();
		for (const e of pathEntriesOrNull) {
			const id = (e as { id?: unknown }).id;
			if (typeof id === "string") set.add(id);
		}
		return set;
	}, [leafWalk.complete, pathEntriesOrNull]);
	const railTurnsInPath = useMemo(
		() => (pathTurnIds ? railTurns.filter(t => pathTurnIds.has(t.entryId)) : railTurns),
		[railTurns, pathTurnIds],
	);
	// TurnRail jump dispatcher (defined here — after loadOlder, which a jump
	// into the folded window pages through). The rail indexes the FULL session,
	// so the target may sit above the loaded window: page older chunks until
	// the entry materializes, then dispatch. (Dispatching immediately would
	// drop the jump — the Transcript resolves rows against the loaded set and
	// ignores requests it cannot find.)
	const requestJumpRef = useRef<((target: JumpTarget) => void) | null>(null);
	const requestJump = useCallback(
		(target: JumpTarget): void => {
			void (async () => {
				// Page until the target is inside the loaded window — the rail indexes
				// the FULL session, so a jump can target a row above the loaded set.
				let guard = 0;
				while (
					rpc &&
					store &&
					resolveJumpEntryId(snapRef.current?.entries, target) === null &&
					store.hasMore &&
					guard < 200
				) {
					guard++;
					await loadOlder();
				}
				// Unresolvable: drop it instead of dispatching a jump the Transcript
				// cannot satisfy. (Visible failure feedback is a separate P1-17 item.)
				const entryId = resolveJumpEntryId(snapRef.current?.entries, target);
				if (!entryId) return;
				jumpNonceRef.current += 1;
				setJumpRequest({ entryId, nonce: jumpNonceRef.current });
			})();
		},
		[rpc, store, loadOlder],
	);
	useEffect(() => {
		requestJumpRef.current = requestJump;
	}, [requestJump]);
	// P1-12: stable identities for the canvas card memo (TmNodeCard): the
	// previous inline arrows changed identity every ChatView render, which
	// recreated TurnMapCanvas's internal useCallbacks (they list these as
	// deps) and re-rendered every memo'd card on every streaming frame.
	// 双击/右键跳转:回对话模式 + 定位该轮(纯导航,不动 leaf)。
	const handleCanvasJumpToEntry = useCallback(
		(entryId: string): void => {
			setViewMode("chat");
			requestJump({ entryId });
		},
		[overviewEntries, requestJump],
	);
	// 「切换到此分支」:显式移动 leaf(session.branchAt,switchToNode 内含
	// 运行中保护 + 跳转)。纯切换语义关 branchAt 的草稿回填(地图锚 = 轮末
	// assistant/工具事件,本就不会回填;user 锚的重答回填属于「重新回答」,
	// 不属于切换),并清掉上一轮重答可能留下的草稿。
	const handleCanvasSwitchToBranch = useCallback(
		(id: string): void => {
			setPendingEdit(null);
			void switchToNode(id, { backfillDraft: false });
		},
		[switchToNode],
	);
	// 重答:分支到该轮并回填草稿(branchAt 定位在该轮本身,下一次发送即
	// 重答;运行中保护在 runTreeOp)。
	const handleCanvasBranchTo = useCallback(
		(id: string): void => {
			// Re-answer is the same leaf move as 撤回 (the turn leaves the active
			// path and its text comes back), so it asks the same question — once.
			const quote = userMessageText(snap?.entries.find(entry => entry.id === id));
			void withdrawSettled(quote, async () => {
				const res = await branchTo(id, id);
				if (res?.editorText) setPendingEdit({ text: res.editorText });
			});
		},
		// Deliberately not listing withdrawSettled: it is a fresh closure each
		// render, and listing it would rebuild this card callback (fed to the
		// memo'd canvas) on every frame. It reads only confirm/runTreeOp/snapRef.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[runTreeOp, branchTo, snap?.entries],
	);
	const handleCanvasForkAt = useCallback(
		(id: string): void => {
			const entry = overviewEntries.find(
				e => typeof e === "object" && e !== null && (e as { id?: unknown }).id === id,
			);
			const isUser = entry?.type === "message" && entry.message.role === "user";
			void forkFromMessage(id, undefined, !isUser);
		},
		[overviewEntries, forkFromMessage],
	);
	const turnsData = useMemo(
		() => ({
			turns: railTurnsInPath,
			hasMoreAbove: store?.hasMore === true,
			// The rail's own pending state: the control must disable itself
			// rather than wait for the transcript's aria-hidden bar to move.
			loadingOlder,
			onRequestOlder: onLoadOlderStable,
		}),
		[railTurnsInPath, store?.hasMore, loadingOlder, onLoadOlderStable],
	);
	// Find-bar docking. `.gui-find` is absolutely positioned against
	// .gui-chat-body (the chat column's own box — it is the offset parent),
	// so the one thing it cannot know is how
	// much of that edge the TurnRail covers: the rail is a 24px absolutely-
	// positioned overlay hugging whichever side the user picked (设置 → 外观),
	// and its extent changes with the rail style and the turn count. Measure
	// it and publish the clearance rather than hardcoding a margin — a fixed
	// inset is what put the bar over the rail, then over the window edge.
	const FIND_EDGE_GAP_PX = 14;
	const FIND_RAIL_GAP_PX = 10;
	const chatBodyRef = useRef<HTMLDivElement | null>(null);
	// TurnRail returns null for an empty turn list, so its presence tracks the
	// same source it is fed; re-measure when that flips.
	const findRailMounted = ((viewMode === "canvas" ? canvasRail.turns : turnsData?.turns)?.length ?? 0) > 0;
	useEffect(() => {
		const host = chatBodyRef.current;
		if (!host) return;
		const sync = () => {
			const rail = host.querySelector(".gui-turn-rail");
			let inset = FIND_EDGE_GAP_PX;
			if (rail instanceof HTMLElement) {
				const hostRect = host.getBoundingClientRect();
				const railRect = rail.getBoundingClientRect();
				// The rail hugs ONE edge; take the nearer side so the bar is pushed
				// inward from the rail instead of off the opposite edge.
				const extent = Math.min(hostRect.right - railRect.right, railRect.left - hostRect.left);
				if (extent > 0) inset = Math.max(inset, Math.ceil(extent + FIND_RAIL_GAP_PX));
			}
			host.style.setProperty("--gui-find-inset-end", `${inset}px`);
		};
		sync();
		const ro = new ResizeObserver(sync);
		ro.observe(host);
		// The rail's extent tracks its own style and the turn count, so observe
		// it too for as long as it is mounted.
		const rail = host.querySelector(".gui-turn-rail");
		if (rail instanceof HTMLElement) ro.observe(rail);
		return () => {
			ro.disconnect();
			host.style.removeProperty("--gui-find-inset-end");
		};
	}, [findRailMounted]);
	// The work-timer badge wants the ACTUAL effort this round used — the
	// last thinking_level_change entry carries the auto-classified resolved
	// level (the agent info tab shows the configured state; the badge must not).
	const resolvedThinkingLevel: string | null = (() => {
		if (!snap) return null;
		let level: string | null = null;
		for (const entry of snap.entries) {
			if (entry.type === "thinking_level_change") level = entry.thinkingLevel ?? null;
		}
		return level ?? snap.state?.thinkingLevel ?? null;
	})();
	// /btw floating card: null = closed, string = active question.
	const [btwQuestion, setBtwQuestion] = useState<string | null>(null);
	// Docked subagent detail (a swarm-card member row, the
	// composer's swarm chip or the agents roster). The detail belongs to the
	// right panel's agents view — the rail is the single navigation axis, so
	// selecting an agent opens THAT surface (expanding a folded panel)
	// instead of a standalone drawer, which the managed-browser page host
	// could cover.
	const [panelAgentId, setPanelAgentId] = useState<string | null>(null);
	// Session switch: the detail belongs to the session whose member row
	// opened it — a stale id must never resolve against another session's
	// agent list. (The store is disposed+recreated per openSession, so
	// without this reset the panel would linger across sessions.)
	useEffect(() => {
		setPanelAgentId(null);
	}, [store]);
	// Leaving the agents surface drops the docked detail: the layer lives in
	// the pane, and no other surface may end up underneath it.
	useEffect(() => {
		if (activeView !== "agents") setPanelAgentId(null);
	}, [activeView]);
	const selectAgent = (id: string | null): void => {
		if (id !== null) store?.markAgentViewed(id);
		setPanelAgentId(id);
	};
	const host = {
		hasAgent: (id: string) => snap?.agents.some(a => a.id === id) === true,
		openAgent: (id: string) => {
			if (snap?.agents.some(a => a.id === id) !== true) return;
			selectAgent(id);
			setActiveView("agents");
			if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
		},
		// Task card "转后台": the daemon adopts the running foreground spawn into
		// a background job, so the turn stops waiting but the agent keeps going.
		// A refusal (agent finished, background jobs disabled) surfaces as an
		// error toast — a silent no-op would read as a dead button.
		detachAgent: (id: string) => {
			void rpc
				.request<{ ok: boolean; jobId?: string; error?: string }>("agents.detach", { agentId: id })
				.then(res => {
					if (res?.ok === true) return;
					pushActionToast({
						kind: "error",
						message: t("tools.detachFailed"),
						details: res?.error,
					});
				})
				.catch((err: unknown) => {
					pushActionToast({
						kind: "error",
						message: t("tools.detachFailed"),
						details: err instanceof Error ? err.message : String(err),
					});
				});
		},
		// Inline widgets hand results back to the conversation (kimi
		// sendPrompt parity) — same path as the composer.
		sendPrompt: (text: string) => sendAndCloseJump(text),
		// Tool cards with a "fix this in settings" action (web search
		// provider failures) jump straight to the matching section.
		openSettings: onOpenSettings ? (section?: string) => onOpenSettings(section) : undefined,
		openArtifact: snap?.sessionId
			? (id: string) => setArtifactPreview({ sessionId: snap.sessionId!, id })
			: undefined,
		// `knowledge` show: put a project plan in front of the user. The panel
		// switches to the project-knowledge surface and opens that plan; without
		// this the tool would claim to have shown something the user never saw.
		showPlan: (request: { directory: string; id: string; title: string }) =>
			openPlanFromChat(request.directory, request.id, request.title),
		// Widget card "下载为图片"/"复制为图片": rasterize the card and hand
		// the blob to the download/clipboard helper. html-to-image is imported
		// dynamically inside rasterizeToBlob on purpose (same as
		// SaveImageDialog): a static import would pull a large dependency into
		// the main bundle for a rarely used action. The rasterizer rebuilds
		// sandboxed iframe faces as same-origin shadows — a plain toBlob clones
		// the opaque-origin frames as EMPTY boxes, which is what exported blank
		// widget images. Failures surface through the toast channel — a silent
		// catch is what once made a blocked export read as a dead button.
		saveImage: (element: HTMLElement, filename: string): void => {
			void (async () => {
				try {
					const backgroundColor = getComputedStyle(element).backgroundColor || "#ffffff";
					const blob = await rasterizeToBlob(element, { pixelRatio: 2, backgroundColor });
					downloadBlob(filename, blob);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					window.dispatchEvent(
						new CustomEvent("musepi-gui-toast", { detail: `${t("settings.widgetDownloadImage")}: ${detail}` }),
					);
				}
			})();
		},
		copyImage: (element: HTMLElement): void => {
			void (async () => {
				try {
					const backgroundColor = getComputedStyle(element).backgroundColor || "#ffffff";
					const blob = await rasterizeToBlob(element, { pixelRatio: 2, backgroundColor });
					await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					window.dispatchEvent(
						new CustomEvent("musepi-gui-toast", { detail: `${t("settings.copyImage2")}: ${detail}` }),
					);
				}
			})();
		},
		// The annotation tool's card-capture step: rasterize the card element
		// to a PNG blob; the overlay compositor merges it with the annotation
		// marks. The card hides the annotate action when this is absent.
		rasterizeCard: (element: HTMLElement) => {
			const backgroundColor = getComputedStyle(element).backgroundColor || "#ffffff";
			return rasterizeToBlob(element, { pixelRatio: 2, backgroundColor });
		},
	};
	// Stop is immediate, matching bare Escape: the daemon keeps queued
	// messages. A blocking confirm made the button a no-op whenever its
	// context was unavailable, so the click always reaches `onStop`.
	const handleStop = useCallback((): void => {
		onStop();
	}, [onStop]);
	// Session composer focus morph: same WAAPI height animation as the
	// welcome form — current → parent height (open) or content height
	// (closed); the inline height is set to the target immediately and the
	// running animation overrides it visually until it finishes.
	//
	// Layout effect (not useEffect): the morph must pin the from-height and
	// start the animation BEFORE the browser paints the commit state. As a
	// passive effect it ran after paint, and opening painted a whole frame
	// of the post-commit layout first — the transcript wrapper is already
	// unmounted (`focusMode ? "hidden" : flex-1`) and the flex column
	// reflows, which visually reads as "the whole composer jumps UP to the
	// bottom of the now-taller remaining column, THEN grows" (the reported
	// wrong ordering). Pinning in the layout phase makes the first painted
	// frame the morph's own from-frame: the composer grows in place.
	//
	// gui-chat.css pins `transition: none` on the wrap for the morph window
	// (`.gui-composer-wrap--morphing`): the class's own `transition: height
	// 280ms` double-drove the WAAPI animation on the same property — two
	// competing 280ms curves fighting every frame (the frame-rate collapse).
	const composerWrapRef = useRef<HTMLDivElement | null>(null);
	// Persistent composer host (one node for BOTH scenes): the wrap lives under
	// `.gui-scenes` and is positioned over the active card, so welcome ⇄ session
	// moves the composer instead of mounting a second one. The box is measured
	// from the card (the session-info seat narrows the column) and the mode
	// change is carried by a translate FLIP on the wrap itself.
	const composerHostRef = useRef<HTMLDivElement | null>(null);
	const scenesRef = useRef<HTMLDivElement | null>(null);
	const [composerHostBox, setComposerHostBox] = useState<{
		left: number;
		top: number;
		width: number;
		height: number;
	} | null>(null);
	const composerModeRef = useRef<boolean>(!!store);
	const composerModeRect = useRef<DOMRect | null>(null);
	const wrapMorphVer = useRef(0);
	/** The in-flight morph animation. Held so a rapid toggle can cancel it
	 *  instead of letting two animations write the same height property. */
	const wrapAnimRef = useRef<Animation | null>(null);

	// Session info dock seat. The dock is a real flex column beside the chat
	// column, so it needs a row wide enough to leave the transcript usable.
	// The ROW is measured, never the chat column: docking shrinks the column,
	// and measuring that would oscillate between the two seats.
	const chatRowRef = useRef<HTMLDivElement | null>(null);
	// The chat card itself: the drop anchor covers this, not the row (the row
	// also carries the right panel, which is not a composer surface).
	const chatColumnRef = useRef<HTMLDivElement | null>(null);
	// Composer file intake, published by whichever composer scene is mounted.
	const attachApiRef = useRef<ComposerAttachApi | null>(null);
	const welcomeCardRef = useRef<HTMLDivElement | null>(null);
	const resolveDropTarget = useCallback(
		(): HTMLElement | null => (showChat ? chatColumnRef.current : welcomeCardRef.current),
		[showChat],
	);
	const stageDroppedFiles = useCallback((files: File[]): void => {
		void attachApiRef.current?.addFiles(files);
	}, []);
	const [chatRowWidth, setChatRowWidth] = useState<number | null>(null);
	useEffect(() => {
		if (!showChat) return;
		const el = chatRowRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const update = (): void => {
			setChatRowWidth(Math.floor(el.getBoundingClientRect().width));
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, [showChat]);

	/**
	 * Publish the floating composer's geometry.
	 *
	 * Two values, and they are not interchangeable:
	 * `--chat-composer-inset` is the slot's current height (the end fade matches
	 * the glass it meets), `--chat-composer-tail-inset` is what the list footer
	 * reserves — the RESTING height plus a gap, so a composer that grows takes
	 * the gap first instead of shoving the transcript on every keystroke.
	 *
	 * They are written onto the readers (the tail spacer and the fade band), not
	 * onto this column: a custom property on the column inherits into every
	 * virtualized row and restyles all of them. See composer-inset-readers.
	 */
	const [composerInset, setComposerInset] = useState(0);
	// Publishes the current height once, on demand. The ResizeObserver below
	// stays silent for the focus-morph window and calls this on release.
	const publishComposerInsetRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (!showChat) return;
		const body = chatBodyRef.current;
		const wrap = composerWrapRef.current;
		if (!body || !wrap || typeof ResizeObserver === "undefined") return;
		const publish = (): void => {
			const height = Math.round(wrap.getBoundingClientRect().height);
			setComposerInset(height);
			const { tailInset } = recordComposerSlotHeight(body, height);
			publishComposerInsets(body, { inset: height, tailInset });
		};
		publishComposerInsetRef.current = publish;
		publish();
		const observer = new ResizeObserver(() => {
			// The ⌘⇧E morph rewrites the wrap height every frame. Publishing each
			// frame re-renders this whole view (inset state) and re-measures the
			// virtual transcript while the morph is already laying out — the
			// stutter the welcome form never had (it owns no such observer).
			// One write at release is enough: nothing below the composer reads
			// the inset mid-morph.
			if (wrap.classList.contains("gui-composer-wrap--morphing")) return;
			publish();
		});
		observer.observe(wrap);
		return () => {
			publishComposerInsetRef.current = null;
			observer.disconnect();
			forgetComposerSlot(body);
			withdrawComposerInsets(body);
		};
	}, [showChat]);

	// Host box = the active card's rect, measured against the scenes wrapper.
	// Both modes render one card of the same box (gutter + row), so the host
	// keeps its geometry and only the wrap inside changes place.
	const measureComposerHost = useCallback((): void => {
		const scenes = scenesRef.current;
		const card = store ? chatColumnRef.current : welcomeCardRef.current;
		if (!scenes || !card) return;
		const a = card.getBoundingClientRect();
		const b = scenes.getBoundingClientRect();
		const next = { left: a.left - b.left, top: a.top - b.top, width: a.width, height: a.height };
		setComposerHostBox(prev =>
			prev &&
			Math.abs(prev.left - next.left) < 0.5 &&
			Math.abs(prev.top - next.top) < 0.5 &&
			Math.abs(prev.width - next.width) < 0.5 &&
			Math.abs(prev.height - next.height) < 0.5
				? prev
				: next,
		);
	}, [store]);
	useLayoutEffect(() => {
		measureComposerHost();
	}, [measureComposerHost, showWelcome, showChat]);
	useLayoutEffect(() => {
		const card = store ? chatColumnRef.current : welcomeCardRef.current;
		const scenes = scenesRef.current;
		if (!card || !scenes || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measureComposerHost);
		observer.observe(card);
		observer.observe(scenes);
		return () => observer.disconnect();
	}, [measureComposerHost, store, showWelcome, showChat]);
	// A ResizeObserver only reports size changes; a late banner or status row
	// can move the card without resizing it, and a stale top reads as the
	// composer sitting off its seat. One frame per commit closes that window
	// (the epsilon bail above stops the re-render loop).
	useEffect(() => {
		const id = requestAnimationFrame(measureComposerHost);
		return () => cancelAnimationFrame(id);
	});

	// Welcome ⇄ session is one node changing place (centered ⇄ docked): a
	// translate FLIP on the wrap reads as the composer moving, not as a second
	// card appearing. The pre-flip rect is captured during render (the same
	// pattern as prevWrapTop below — the DOM still shows the old layout).
	useLayoutEffect(() => {
		const wrap = composerWrapRef.current;
		const mode = !!store;
		const flipped = composerModeRef.current !== mode;
		composerModeRef.current = mode;
		if (!wrap || !flipped || motionDisabled()) return;
		// Anchor on the input card, not the wrap: the hero seat fills the whole
		// card and centres the card inside it, so the wrap's own top is the
		// surface top, not where the composer visually sits. A translation
		// computed from the card moves the wrap's content identically.
		const next = (wrap.querySelector<HTMLElement>(".gui-composer-frame") ?? wrap).getBoundingClientRect();
		const prev = composerModeRect.current;
		composerModeRect.current = next;
		if (!prev || typeof wrap.animate !== "function") return;
		const dx = prev.left - next.left;
		const dy = prev.top - next.top;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
		wrap.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
			duration: 240,
			easing: "cubic-bezier(0.22, 1, 0.36, 1)",
			composite: "replace",
		});
	}, [store]);

	// The ask card floats ABOVE the composer (`bottom: calc(100% + 4px)` in
	// gui-misc.css — the 4px gap is part of the clearance). Its box never
	// enters the wrap, so the wrap's ResizeObserver cannot measure it; without
	// a published clearance it would cover the last transcript rows. Publish
	// its height + gap as `--chat-floating-panel-clearance` (the tail spacer
	// and the end fade add it) while it is mounted.
	const askFloatRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const panel = askFloatRef.current;
		const column = chatBodyRef.current;
		if (!panel || !column) return;
		const publish = (): void => {
			publishFloatingPanelClearance(column, Math.ceil(panel.getBoundingClientRect().height + 4));
		};
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(panel);
		return () => {
			observer.disconnect();
			withdrawFloatingPanelClearance(column);
		};
	}, [ask]);
	// Pre-toggle wrap top, captured during render (the DOM still shows the
	// previous commit's layout). The morph animates translateY against it:
	// the morph-window layout seats the wrap at its STEADY-STATE top, so a
	// plain height animation would paint frame 1 at the final position and
	// read as "the composer jumps first, then grows". First keyframe =
	// layout position + translateY(preTop - layoutTop) = the true
	// pre-toggle rect; the offset eases to 0 — both edges travel the
	// curve, no jump in either direction.
	const prevWrapTop = useRef<number | null>(null);
	const wrapEl = composerWrapRef.current;
	if (wrapEl) prevWrapTop.current = wrapEl.getBoundingClientRect().top;
	// Pre-flip rect for the welcome ⇄ session FLIP. Skipped on the render that
	// flips the mode, so the captured value is still the outgoing layout.
	if (wrapEl && composerModeRef.current === !!store) {
		composerModeRect.current = (
			wrapEl.querySelector<HTMLElement>(".gui-composer-frame") ?? wrapEl
		).getBoundingClientRect();
	}
	useLayoutEffect(() => {
		const el = composerWrapRef.current;
		if (!el) return;
		const from = el.getBoundingClientRect().height;
		let target: number;
		if (focusMode) {
			target = el.parentElement?.getBoundingClientRect().height ?? from;
		} else {
			// Unpinned content height (scrollHeight returns the element's
			// own height while the pinned inline height is set).
			const prev = el.style.height;
			el.style.height = "";
			void el.offsetHeight;
			target = el.getBoundingClientRect().height;
			el.style.height = prev;
		}
		if (Math.abs(from - target) < 1) {
			// No size change — release any pinned height so autosize flows.
			if (!focusMode) el.style.height = "";
			return;
		}
		// A View Transition owns the focus toggle when the browser has it: the
		// composer wrap carries `composer-surface`, so the browser morphs its
		// rect on one composited group. Running the WAAPI height animation on
		// top would double-drive height and read as two competing motions —
		// settle the final layout inside the transition instead.
		if (typeof document !== "undefined" && document.documentElement.classList.contains("gui-view-transition")) {
			// Freeze the CSS height transition for the same window: the browser
			// owns geometry now, and a 280ms transition running underneath the
			// transition snapshots is a second motion the user never asked for.
			el.style.transition = "none";
			el.style.height = focusMode ? `${target}px` : "";
			publishComposerInsetRef.current?.();
			wrapAnimRef.current = null;
			window.setTimeout(() => {
				el.style.transition = "";
				publishComposerInsetRef.current?.();
			}, 420);
			return;
		}
		// Reduced motion: land on the target immediately. WAAPI animations
		// are NOT covered by CSS @media rules, so without this early return
		// the user who asked for less motion still gets the full morph.
		if (motionDisabled()) {
			el.style.height = focusMode ? `${target}px` : "";
			return;
		}
		// Pin the TARGET height first: the layout then seats the wrap at
		// its steady-state top (bottom-anchored via --bottom-anchor while
		// focused), which is exactly the position the animation must land
		// on. Measure that seat before starting the animation.
		el.style.height = `${target}px`;
		el.classList.add("gui-composer-wrap--morphing");
		void el.offsetHeight;
		// The readers take the TARGET height up front: the observer skips the
		// morph, and leaving focus would otherwise keep the full-height tail
		// reserve until release while the transcript is already visible.
		publishComposerInsetRef.current?.();
		const layoutTop = el.getBoundingClientRect().top;
		const dy = prevWrapTop.current !== null ? prevWrapTop.current - layoutTop : 0;
		const fromTx = Math.abs(dy) >= 1 ? `translateY(${dy}px)` : "none";
		// A rapid ⌘⇧E toggle interrupts the previous morph. The version
		// guard below stops its `release`, but the old animation would keep
		// writing height every frame, fighting the new one on the same
		// property. Cancel it for real before starting the new one.
		wrapAnimRef.current?.cancel();
		const anim = el.animate(
			[
				{ height: `${from}px`, transform: fromTx },
				{ height: `${target}px`, transform: "none" },
			],
			{
				duration: COMPOSER_MORPH_MS,
				easing: COMPOSER_MORPH_EASING,
			},
		);
		wrapAnimRef.current = anim;
		// Release the pinned height once the morph settles (finish event is
		// unreliable — cancelled animations never fire it, headless never
		// advances — so a versioned timer backs it up). Open must stay
		// pinned (the fill); closed releases so autosize growth flows.
		const ver = ++wrapMorphVer.current;
		const release = (): void => {
			if (wrapMorphVer.current !== ver) return;
			el.classList.remove("gui-composer-wrap--morphing");
			if (!focusMode) el.style.height = "";
			if (wrapAnimRef.current === anim) wrapAnimRef.current = null;
			// The observer skipped every frame of the morph; publish the settled
			// height once so the tail spacer and the rail catch up.
			publishComposerInsetRef.current?.();
		};
		anim.addEventListener("finish", release);
		setTimeout(release, COMPOSER_MORPH_MS + 40);
		return () => {
			// Effect cleanup on unmount or a new focusMode tick: cancel the
			// animation so it cannot outlive the state it was morphing
			// towards. A cancelled animation never fires `finish`, so the
			// version guard is what keeps stale releases from unpinning a
			// newer morph.
			anim.cancel();
			if (wrapAnimRef.current === anim) wrapAnimRef.current = null;
		};
	}, [focusMode]);

	// Session info seat: the card's own preference (app.tsx) decides WHETHER it
	// shows; this decides WHERE. The dock is a flex sibling of the chat column,
	// so its width IS the chat column's push/pull. An open panel does not move
	// the card: it keeps that column between the chat and the panel while the
	// row still fits both, and folds to 0 (one spring, same as the panel) when
	// it does not. Before the first measurement it docks, so a wide window never
	// flashes a float card in the corner it is about to leave.
	const sessionInfoDockMinRow = SESSION_INFO_DOCK_MIN_ROW_PX;
	// `chatRowWidth === null` means "not measured yet", which is the common case
	// on the welcome scene (`showChat` is false there, so the observer never
	// runs). Treating it as "wide enough" docked a 304px column into a 771px
	// row and squeezed the chat column to 451px, where tool cards wrapped one
	// character per line — the width budget must admit it does not know yet.
	// An open right panel owns the row's spare width, so the card floats over the
	// transcript instead of taking its own column: three columns (chat, card,
	// panel) squeeze the conversation into a strip too narrow to read code in.
	// The dock is for the panel-closed layout, where the column is the card's
	// permanent seat.
	const sessionInfoDock = !rightPanelOpen && chatRowWidth !== null && chatRowWidth >= sessionInfoDockMinRow;
	// The card stays mounted through its exit window so the seat folds instead
	// of the row re-laying out in one frame.
	const sessionInfoDockOpen = sessionInfoOpen && !focusMode && sessionInfoDock;
	// A narrow row cannot dock, so the fallback seat floats OVER the transcript.
	// Auto-showing it there covers the conversation the card is meant to
	// summarize, so that seat waits for an explicit toggle.
	const sessionInfoNarrowRow = !sessionInfoDock;
	const [sessionInfoFloatRequested, setSessionInfoFloatRequested] = useState(false);
	const sessionInfoSessionId = store?.sessionId ?? null;
	useEffect(() => {
		// Another session's preference decides its own seat; a narrow-row reveal
		// does not carry over.
		setSessionInfoFloatRequested(false);
	}, [sessionInfoSessionId]);
	const sessionInfoFloatOpen = sessionInfoOpen && !focusMode && !sessionInfoDock && sessionInfoFloatRequested;
	// What the narrow-row toggle drives: the float seat needs BOTH the stored
	// preference and an explicit request, so the click flips the pair instead of
	// reading back the rendered seat — focus mode or a leftover request must not
	// swallow it.
	const sessionInfoFloatChosen = sessionInfoOpen && sessionInfoFloatRequested;
	const sessionInfoVisible = sessionInfoDockOpen || sessionInfoFloatOpen;
	const sessionInfoDockPresence = useExitPresence(sessionInfoDockOpen, SESSION_INFO_SEAT_EXIT_MS);
	const sessionInfoFloatPresence = useExitPresence(sessionInfoFloatOpen, SESSION_INFO_SEAT_EXIT_MS);
	// A draft session's connector pick was stored under the cwd while the
	// welcome composer owned it; that composer unmounts the moment the first
	// message creates a session, so the write-back is driven here instead.
	const connectorFlushedSessionRef = useRef<string | null>(null);
	const connectorSessionId = store?.sessionId ?? null;
	const connectorCwd = store?.cwd ?? null;
	useEffect(() => {
		if (!rpc || !connectorSessionId) return;
		if (connectorFlushedSessionRef.current === connectorSessionId) return;
		connectorFlushedSessionRef.current = connectorSessionId;
		void flushPendingConnectorSelection(rpc, connectorSessionId, connectorCwd);
	}, [rpc, connectorSessionId, connectorCwd]);
	// One props object, two seats: the dock is a SIBLING of the chat column (it
	// must never overlay the transcript), the float card lives inside it.
	const sessionInfoCardProps = {
		sessionId: store?.sessionId ?? null,
		rpc,
		cwd: store?.cwd ?? null,
		title: sessionTitle ?? null,
		tabs: panelTabs.tabs,
		activeTabId: panelTabs.activeId,
		progress: snap?.progress ?? null,
		entries: snap?.entries ?? [],
		working: snap?.working ?? false,
		onSelectTab: (id: string): void => {
			panelTabs.activate(id);
			if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
		},
		onOpenSurface: (id: string): void => {
			setActiveView(id);
			if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
		},
		onOpenSettings: (section?: string): void => {
			onOpenSettings?.(section);
		},
		// Context shake rewrites persisted entries without an entry event; the
		// card asks for the same snapshot reload the no-reply check uses.
		onSessionRewritten: (): void => {
			void verifyTranscript();
		},
		// Shake keeps its recovery snapshot as a session artifact; the status
		// line links to the same read-only preview tool cards use.
		onOpenArtifact: (id: string): void => {
			const sessionId = store?.sessionId;
			if (sessionId) setArtifactPreview({ sessionId, id });
		},
	};

	// The input card is a Cordis seat (`conversation.composer.bar`). The host owns every
	// piece of state; the built-in Composer is the fallback when no contribution
	// renders, and a contribution receives this same props object.
	const heroComposerProps: { mode: "hero" } & HeroComposerProps = {
		mode: "hero",
		busy,
		rpc,
		project,
		onProject,
		focused: focusMode,
		onToggleFocus,
		presetModelId: defaultModelId,
		presetThinkingLevel,
		onSubmit: (text, opts) => onSubmitNewSession(text, opts),
		reminders,
		onSelectReminder,
		onMarkAllRead,
		modes,
		modeId,
		onModeChange,
		designSubmit: onDesignSubmit,
		onAddProvider,
		attachApiRef,
	};
	const sessionComposerProps: SessionComposerProps | null = store
		? {
				working: snap?.working ?? false,
				entries: snap?.entries ?? [],
				companionMood: companionMoodFromSession({
					working: snap?.working ?? false,
					streaming: snap?.streaming ?? false,
					hasApprovals: (snap?.approvals.length ?? 0) > 0,
				}),
				companionState: companionStateFromSignals(agentSignals),
				onSend: sendAndCloseJump,
				onStop: () => void handleStop(),
				onOpenBackgroundJobs: () => {
					setActiveView("jobs");
					if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
				},
				rpc,
				sessionId: store.sessionId,
				cwd: store.cwd,
				attachApiRef,
				welcome: showWelcome,
				// The capsule opens the agent info tab; the chip would duplicate it.
				keepModelChip: false,
				quotes,
				onQuotesChange: setQuotes,
				pendingEdit,
				onEditConsumed: () => setPendingEdit(null),
				focused: focusMode,
				onToggleFocus,
				onBtw: q => setBtwQuestion(q),
				activeTask:
					displaySettings["display.taskCardStyle"] === "classic"
						? null
						: ([...(snap?.activeTools?.values() ?? [])].filter(t => t.toolName === "task").at(-1) ?? null),
				swarmHost: host,
			}
		: null;

	return (
		<main
			id={`session-panel-${store?.sessionId ?? "welcome"}`}
			role="tabpanel"
			className="gui-pane-center relative flex min-h-0 min-w-0 flex-1 flex-col"
		>
			{/* Selection→ask popover (session-scoped throwaway turns). */}
			<AskPopover rpc={rpc} sessionId={store?.sessionId ?? null} />
			{/* OS file drops: one anchor for the active scene's card, staging the
			 * files on whichever composer is mounted (session or welcome). */}
			<ChatDropAnchor resolveTarget={resolveDropTarget} onFiles={stageDroppedFiles} />
			{/* Window drag strip: the 8px margin above the floating surface
			 * plus the header's blank areas stay draggable; every button inside
			 * is no-drag. */}
			<div className="gui-drag-strip" aria-hidden />
			{/* Workspace split: the session column,
			 * the side pane and the terminal dock are INDEPENDENT rounded cards
			 * floating on the glass base — no more single
			 * card with a vertical divider. This wrapper is layout-only now;
			 * each region carries its own card chrome. `gui-chat-surface` stays
			 * as the JS anchor for the maximize measurement query. The window
			 * header (GuiHeader) is a separate container ABOVE it. */}
			<div
				className="gui-chat-surface flex min-h-0 flex-1 flex-col"
				/* Card-to-card spacing is owned by each card's own gutter margin
				 * (gui-chat.css "Workspace card gutters") — a flex gap here would
				 * stack on top of those margins and double the scenes→dock
				 * breath. The surface margin is the window gutter only. */
				style={{ margin: "var(--gui-card-gutter)" }}
			>
				{/* One row owns the workspace width: the scene stack (welcome or
				 * chat) beside the ALWAYS-present right column — dock seat, panel
				 * shell and rail. The rail is a shell-level destination, not a
				 * child of the chat scene, so the welcome screen keeps it
				 * (OpenChamber layout parity) and the panel opens there onto its
				 * empty-state page. `chatRowRef` measures this row for the
				 * session-info dock threshold; the panel and rail are part of the
				 * width it reports, exactly as they were when nested in the chat
				 * scene. */}
				<div ref={chatRowRef} className="flex min-h-0 flex-1">
					{/* Scene stack: both scenes mount during the 420ms overlap window,
					 * each absolute-filling this wrapper (so they cross-fade/morph
					 * full-surface). The wrapper itself is IN FLOW — the terminal
					 * dock after it genuinely pushes the scenes up instead of the
					 * dock becoming the only in-flow child and landing on top. */}
					<div ref={scenesRef} className="gui-scenes relative min-h-0 min-w-0 flex-1">
						{showWelcome && (
							<div
								className={`gui-scene gui-scene-welcome relative min-h-0 flex-1 gui-scene--enter${welcomeLeaving ? " gui-scene--leaving" : ""}`}
							>
								{/* Same rounded floating card as the chat scene and the
								 * settings main view: the welcome scene used to sit
								 * directly on the glass, so it read as "not a rounded
								 * container" (user report 2026-09-16). */}
								<div
									ref={el => {
										welcomeCardRef.current = el;
									}}
									className="gui-float-card gui-welcome-card flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]"
									style={{
										margin: "var(--gui-card-gutter)",
										position: "relative",
										paddingRight: terminalPlacement === "right" && terminalOpen ? rightWidth : 0,
									}}
								>
									{/* Background card only: the composer itself lives in the
									 * persistent host below the scenes, so welcome ⇄ session
									 * moves one DOM node instead of mounting a second one. */}
								</div>
							</div>
						)}
						{showChat && store && (
							<div
								className={`gui-scene gui-scene-chat flex min-h-0 flex-1 flex-col gui-scene--enter${chatLeaving ? " gui-scene--leaving" : ""}${showWelcome ? " gui-scene-chat--direct" : ""}`}
							>
								<div className="flex min-h-0 flex-1">
									{/* Session column: transcript + composer + dock. The
									 * docked session-info seat is this scene's sibling; the
									 * panel and rail live one level up, on the shared
									 * workspace row, so they survive the welcome ⇄ chat
									 * scene swap. */}
									<div
										ref={el => {
											chatColumnRef.current = el;
										}}
										className="gui-chat-column gui-float-card flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-surface)]"
									>
										{/* Maximize anchor (docs §3.3.2): the floated panel and
										 * its backdrop measure THIS column — the old target
										 * (.gui-chat-surface) also contains the panel and the
										 * rail, so maximizing swallowed the rail. */}
										{/* Chat-card header row: the Chat|Canvas switch on the left,
										 * the session-info toggle on the right. A real row rather
										 * than an absolute overlay — an overlay sat on top of the
										 * first transcript row (message corner, hover quote pill)
										 * and stole its pointer. In focus mode the row keeps its
										 * flow slot (visibility, like the body) so the composer
										 * morph starts from the measured layout. */}
										<div
											className={focusMode ? "gui-chat-head gui-chat-head--focused-hidden" : "gui-chat-head"}
										>
											<div className="gui-chat-head-left">
												{parentSession && store && (
													<button
														type="button"
														className="gui-parent-back"
														title={parentSession.label ?? t("general.backParent")}
														onClick={() => onOpenParentSession?.(parentSession.id)}
													>
														<Icon name="arrow-go-back" className="h-3 w-3 flex-shrink-0" />
														<span className="gui-parent-back-label">
															{t("general.backParent")}
															{parentSession.label ? ` · ${parentSession.label}` : ""}
														</span>
													</button>
												)}
												{/* Layer-3: Chat | Canvas 顶层切换(canvas = 会话树地图)。 */}
												<div className="gui-surface-mode" role="tablist">
													<button
														type="button"
														role="tab"
														aria-selected={viewMode === "chat"}
														className={`gui-surface-mode-btn${viewMode === "chat" ? " gui-surface-mode-btn--on" : ""}`}
														onClick={() => setViewMode("chat")}
													>
														<Icon name="chat-history" className="h-3 w-3" />
														{t("transcript.surfaceChat")}
													</button>
													<button
														type="button"
														role="tab"
														aria-selected={viewMode === "canvas"}
														className={`gui-surface-mode-btn${viewMode === "canvas" ? " gui-surface-mode-btn--on" : ""}`}
														onClick={() => setViewMode("canvas")}
													>
														<Icon name="apps-2-ai" className="h-3 w-3" />
														{t("transcript.surfaceCanvas")}
													</button>
												</div>
											</div>
											{/* Agent identity capsule — the conversation's ONE agent avatar,
											 * centered inside the band the scroller reserves for the
											 * head row, so it covers no message, none of the sticky
											 * prompt and none of the composer; scrolling moves only
											 * the rows beneath it (pinned chrome, never faded).
											 * Horizontal: the orb, the assistant name, a compact role
											 * tag (the lane the agent runs in), then the live state.
											 * Chat only: the canvas has its own top controls and no
											 * reserved band. `data-agent-status` / `data-agent-role`
											 * are the stable hooks the geometry and role tests assert
											 * on. */}
											{viewMode === "chat" && (
												<button
													type="button"
													className={`gui-agent-capsule${snap?.working ? " gui-agent-capsule--working" : ""}`}
													data-agent-status={
														snap?.approvals.length ? "waiting" : snap?.working ? "working" : "idle"
													}
													data-agent-role={agentRole.id}
													aria-expanded={agentInfoExpanded}
													title={t(agentInfoExpanded ? "general.agentInfoHide" : "general.agentInfoShow")}
													onClick={toggleAgentInfo}
												>
													{showAvatars && (
														<AgentAvatar
															state={orb}
															size={24}
															signals={agentSignals}
															seed={store.sessionId}
														/>
													)}
													<span className="gui-agent-capsule-name">{agentDisplayName(agentRole)}</span>
													{agentRoleLabel(agentRole) !== agentDisplayName(agentRole) && (
														<span className="gui-agent-role-tag">{agentRoleLabel(agentRole)}</span>
													)}
													<span className="gui-agent-capsule-sep" aria-hidden="true" />
													<span className="gui-agent-capsule-status">{agentCapsuleStatus}</span>
													<span className="gui-agent-capsule-go" aria-hidden="true">
														<Icon name="arrow-right-s" className="h-3 w-3" />
													</span>
												</button>
											)}
											{/* Message-tree navigation sits in the header row, left of the
											 * session-info toggle. The old absolute button floated over
											 * the first transcript row and stole its hover/quote pill.
											 * No onNavigateTo: a row click is a jump, not a leaf switch. */}
											<MessageTreeButton
												entries={snap?.entries ?? []}
												onJump={entryId => requestJump({ entryId })}
												onFork={(entry, text, includeTarget) =>
													void forkFromMessage(entry.id, text, includeTarget)
												}
												onRevertTo={entry => void rewindFromUserMessage(entry.id, userMessageText(entry))}
												activePathIds={trustedPathIds}
											/>
											{onToggleSessionInfo && (
												<button
													type="button"
													className="gui-chat-info-toggle"
													aria-pressed={sessionInfoVisible}
													title={
														sessionInfoVisible
															? t("general.sessionInfoHide")
															: t("general.sessionInfoShow")
													}
													aria-label={
														sessionInfoVisible
															? t("general.sessionInfoHide")
															: t("general.sessionInfoShow")
													}
													onClick={() => {
														if (!sessionInfoNarrowRow) {
															onToggleSessionInfo();
															return;
														}
														// Narrow row: the float is the only seat, and it needs both the
														// stored preference and an explicit request, so each click sets
														// or clears the pair instead of reading back the rendered seat.
														if (sessionInfoFloatChosen) setSessionInfoFloatRequested(false);
														else setSessionInfoFloatRequested(true);
														if (sessionInfoFloatChosen === sessionInfoOpen) onToggleSessionInfo();
													}}
												>
													<MorphIcon
														icon={InfoIconData}
														size={14}
														spring="snappy"
														reducedMotion="user"
														aria-hidden
													/>
												</button>
											)}
										</div>
										{/* Focus mode hides the whole transcript column (not just the
										 * scroll container): the wrapper also carries flex:1, so
										 * leaving it mounted would split the surface in half and
										 * the composer could never fill it. */}
										<div
											ref={chatBodyRef}
											className={
												focusMode
													? "gui-chat-body--focused-hidden"
													: "gui-chat-body relative flex min-h-0 min-w-0 flex-1 flex-col"
											}
											/* A live reply the view follows: the end fade band turns
											 * solid over the composer zone (`.gui-chat-fade--end`,
											 * gui-chat.css) so no ghost row bleeds through the
											 * glass while the newest line streams in. At rest the
											 * band is a ramp and rows slide under the glass, which
											 * is what makes it read as floating. */
											data-live-tail={snap?.working ? "true" : undefined}
										>
											{paused === true && (
												<div className="gui-pause-banner" role="status" aria-live="polite">
													<span className="gui-pause-banner-icon">
														<Icon name="pause" className="h-3.5 w-3.5" />
													</span>
													<span className="gui-pause-banner-text">
														{t("tools.paused")}
														{pausedAt ? (
															<span className="gui-pause-banner-timer" data-paused-at={pausedAt}>
																{" "}
																· {formatPauseElapsed(pausedAt)}
															</span>
														) : null}
													</span>
													{onResume && (
														<button
															type="button"
															className="gui-pause-banner-resume"
															onClick={() => onResume()}
														>
															{t("tools.resume")}
														</button>
													)}
												</div>
											)}
											{pendingCallsNotice && dismissedPendingCalls !== pendingCallsNotice.signature && (
												<div className="gui-pending-calls" role="status" aria-live="polite">
													<span className="gui-pending-calls-text">
														{t("tools.pendingToolCalls", {
															count: pendingCallsNotice.count,
															calls: pendingCallsNotice.calls,
														})}
													</span>
													<button
														type="button"
														className="gui-pending-calls-dismiss"
														onClick={() => setDismissedPendingCalls(pendingCallsNotice.signature)}
													>
														{t("tools.dismissNotice")}
													</button>
												</div>
											)}
											{/* Scroll-shadow: a real
											 * content fade via mask-image, applied only while the
											 * transcript overflows (top/bottom data attrs). */}
											<div className="gui-transcript-wrap relative min-h-0 min-w-0 flex-1">
												{store && (
													<div className="gui-pip-host" ref={registerComposerInsetReader}>
														<ComputerViewerPipView
															activeTools={snap?.activeTools ?? EMPTY_ACTIVE_TOOLS}
															sessionKey={store.sessionId}
															blocked={(snap?.approvals.length ?? 0) > 0}
														/>
													</div>
												)}
												{/* History-session cold-open skeleton (React-Bits style):
												 * the daemon reactivates the session on demand — cover
												 * the (stale) previous transcript while the RPC runs. */}
												{sessionLoading === true && (
													<div
														className="gui-session-loading"
														role="status"
														aria-label={t("settings.loadingSession")}
													>
														<div className="gui-loading-skeleton" aria-hidden>
															<span className="gui-loading-bar" />
															<span className="gui-loading-bar" style={{ width: "82%" }} />
															<span className="gui-loading-bar" style={{ width: "58%" }} />
														</div>
														<div className="gui-loading-note">
															<span className="gui-loading-orb" aria-hidden />
															{t("settings.loadingSession")}
															{/* Elapsed, once the wait is long enough to notice. A frozen
														    skeleton reads as "it broke"; a live number reads as
														    "it is working". */}
															{(waitSeconds ?? 0) >= 2 ? (
																<span className="gui-loading-elapsed">
																	{t("settings.waitingSWithSeconds", { seconds: String(waitSeconds) })}
																</span>
															) : null}
														</div>
													</div>
												)}
												{viewMode === "canvas" ? (
													<TurnMapCanvas
														entries={overviewEntries}
														loading={snap?.historyLoading === true && overviewEntries.length === 0}
														hasMore={store?.hasMore ?? false}
														loadingOlder={snap?.historyLoading === true}
														historyBlocked={store?.historyBlocked ?? false}
														onLoadOlder={onLoadOlderStable}
														roundDurations={snap?.roundDurations}
														leafId={effectiveLeaf}
														pathIds={onPathIds}
														onJumpToEntry={handleCanvasJumpToEntry}
														onSwitchToBranch={handleCanvasSwitchToBranch}
														onBranchTo={handleCanvasBranchTo}
														onForkAt={handleCanvasForkAt}
														composerInset={composerInset}
													/>
												) : (
													<>
														<div
															ref={transcriptScrollerRef}
															className={`gui-transcript min-h-0 min-w-0 h-full overflow-y-auto px-5 py-4${sessionLoading === true ? "" : " gui-transcript--fadein"}`}
															data-top-scroll="false"
															data-bottom-scroll="false"
														>
															<CodeHighlightProvider highlight={chatHighlight}>
																<Transcript
																	key={store?.sessionId ?? ""}
																	entries={visibleEntries}
																	sessionKey={store?.sessionId ?? ""}
																	registerComposerInsetReader={registerComposerInsetReader}
																	/* The branch bar lists siblings that are OFF the
																	 * active path, so it needs the full tree while the
																	 * transcript renders the path. */
																	branchEntries={snap?.entries ?? []}
																	/* No stream ghost: the view folds the assistant message into
																	 * entries at message_start, so the entry row IS the live
																	 * stream renderer (immutable upserts re-render it). */
																	stream={null}
																	streamDone={true}
																	jumpRequest={jumpRequest}
																	activeTools={snap?.activeTools ?? new Map()}
																	working={snap?.working ?? false}
																	roundDurations={snap?.roundDurations}
																	thinkingLevel={resolvedThinkingLevel ?? undefined}
																	host={host}
																	renderTranscriptNode={renderTranscriptNode}
																	onOpenCompaction={openCompaction}
																	/* Codex 编辑预览 parity: the lightbox edit button
																	 * opens the composer's sketch board with the image
																	 * as its base layer (event channel — the board
																	 * state lives inside the Composer). */
																	onEditImage={src => {
																		window.dispatchEvent(
																			new CustomEvent("musepi-gui-sketch-open", {
																				detail: { dataUrl: src },
																			}),
																		);
																	}}
																	/* Chat settings: user message
																	 * markdown/plain + long-message collapse. */
																	userPlain={(() => {
																		try {
																			return (
																				localStorage.getItem("musepi-gui-chat-usermsg") === "plain"
																			);
																		} catch {
																			return false;
																		}
																	})()}
																	collapseLongUserMessages={(() => {
																		try {
																			return (
																				localStorage.getItem("musepi-gui-chat-collapseuser") !== "0"
																			);
																		} catch {
																			return true;
																		}
																	})()}
																	defaultRoundFoldExpanded={defaultRoundFoldExpanded}
																	toolCallSummary={toolCallSummary}
																	stickyUserPrompt={stickyUserPrompt}
																	/* TUI display-settings parity: the daemon
																	 * settings drive the transcript (unflagged
																	 * from tuiOnly 2026-08-12). */
																	smoothStreaming={
																		displaySettings["display.smoothStreaming"] !== false
																	}
																	hideToolActivity={
																		displaySettings["display.hideToolActivity"] === true
																	}
																	showTokenUsage={displaySettings["display.showTokenUsage"] === true}
																	collapseCompacted={
																		displaySettings["display.collapseCompacted"] === true
																	}
																	liveActivityRows={
																		// The setting is a NAMED choice ('all' | '3' | '5' | '7' | '10'), so a
																		// bare 0 can never be mistaken for 'show nothing'.
																		activityRowsToNumber(displaySettings["display.liveActivityRows"])
																	}
																	taskCardStyle={
																		displaySettings["display.taskCardStyle"] === "classic"
																			? "classic"
																			: "swarm"
																	}
																	colorBlind={displaySettings.colorBlindMode === true}
																	onQuote={(text, messageId) => appendQuote(text, messageId)}
																	onJumpToMessage={entryId => requestJump({ entryId })}
																	/* 撤回: move the leaf only — nothing is
																	 * backfilled into the composer (与「编辑并
																	 * 重发」互补)。 */
																	onRevert={(id, text) => void rewindFromUserMessage(id, text)}
																	/* 编辑并重发 (TUI navigateTree 选用户消息 parity):
																	 * branchAt 到该消息(leaf 落父节点,旧尾部成为
																	 * sibling branch)+ 原文回填 composer——发送即在
																	 * 该位置重答。后果与撤回相同(唯一的区别是草稿
																	 * 里已经填好原文),所以问同一句。 */
																	onEdit={(id, text) =>
																		void withdrawSettled(text, () => jumpBackToMessage(id, text))
																	}
																	onFork={(id, text, includeTarget) =>
																		void forkFromMessage(id, text, includeTarget)
																	}
																	onLoadOlder={onLoadOlderStable}
																	loadingOlder={loadingOlder}
																	historyBlocked={store.historyBlocked}
																	anchorCtlRef={anchorCtlRef}
																	onRetry={(id, _text) => void regenerateFromAssistant(id)}
																	onSpeak={(text, id) => {
																		// TTS read-aloud via the daemon's local Kokoro worker;
																		// 行级播放状态(朗读中 → 该行按钮高亮,点击停止)。
																		if (stopSpeakRef.current) {
																			stopSpeakRef.current();
																			setSpeakingId(null);
																			return;
																		}
																		// Manual read-aloud takes over the shared audio graph.
																		autoSpeakerRef.current?.stop();
																		autoSpeakerRef.current = null;
																		autoSpeakerKeyRef.current = null;
																		const entryId = id ?? null;
																		stopSpeakRef.current = speak(
																			text,
																			rpc,
																			{
																				rate:
																					typeof displaySettings["tts.rate"] === "number"
																						? (displaySettings["tts.rate"] as number)
																						: undefined,
																			},
																			activity => {
																				if (activity.phase === "speaking") setSpeakingId(entryId);
																				else if (
																					activity.phase === "done" ||
																					activity.phase === "stopped"
																				) {
																					stopSpeakRef.current = null;
																					setSpeakingId(prev => (prev === entryId ? null : prev));
																				} else if (activity.phase === "error") {
																					stopSpeakRef.current = null;
																					setSpeakingId(prev => (prev === entryId ? null : prev));
																					dispatchNotification("error", {
																						lastMessage: activity.message,
																					});
																				}
																			},
																		);
																		setSpeakingId(entryId);
																	}}
																	speakingId={speakingId}
																	onStopSpeak={() => {
																		stopSpeakRef.current?.();
																		stopSpeakRef.current = null;
																		setSpeakingId(null);
																	}}
																	onSaveImage={text => setSaveImageText(text)}
																	/* One identity per conversation, not one per
																	 * row: the agent's orb lives in the centered
																	 * capsule above the transcript and the user's
																	 * picture is the rail's account button. Empty
																	 * gutters let every row reclaim the 64px orb /
																	 * 28px user column (`.tr-gutter:empty`,
																	 * gui-chat.css) so the text gets the full
																	 * width. */
																	userGutter=""
																	agentGutter=""
																	/* Layer-1 branch topology: multi-child messages render a
																	 * switchable branch bar; off-path entries collapse. */
																	branchInfo={{
																		childCount: new Map(
																			[...branchChildren.entries()].map(([pid, kids]) => [
																				pid,
																				kids.length,
																			]),
																		),
																		activePathIds,
																		onSwitchBranch: switchBranch,
																	}}
																/>
															</CodeHighlightProvider>
															{/* Tail spacer. The composer floats over this
															 * scroller, so without a reserved band the last
															 * row would sit under it. INSIDE the scroller on
															 * purpose: only scroll content counts toward
															 * scrollHeight — parked below the scroller (its
															 * old spot) it never entered the pin math and the
															 * last row hid under the composer. The height is a
															 * CSS variable the composer's ResizeObserver writes
															 * (see the --chat-composer-inset effect), so a
															 * growing textarea or a queue row resizes the
															 * footer without re-rendering the list. The band is
															 * exactly the floating stack's height, because every
															 * dock (approvals, asks, jump-back, session-tree nav)
															 * is a child of the wrap. While the session works
															 * the growth allowance is off: the working strip and
															 * the live-end fade sit in the gap, so a composer
															 * grown into it (a queued message, the working strip)
															 * left the last line under the glass. The ask card
															 * above the composer is absolutely anchored (not part
															 * of the wrap), so its published clearance is added
															 * on top. */}
															<div
																className="gui-chat-tail-spacer flex-shrink-0"
																ref={registerComposerInsetReader}
																style={{
																	height: `calc(${
																		(snap?.working ?? false)
																			? `max(var(--chat-composer-tail-inset, ${FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX}px), calc(var(--chat-composer-inset, 0px) + ${FLOATING_COMPOSER_GAP_PX}px))`
																			: `var(--chat-composer-tail-inset, ${FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX}px)`
																	} + var(--chat-floating-panel-clearance, 0px))`,
																}}
																aria-hidden="true"
															/>
														</div>
														{/* Jump-to-bottom: the shared client-core Transcript owns the
														 * canonical .tr-back-bottom (M1.10 follow re-arm).
														 * The old desktop-local JumpToBottomButton was a DUPLICATE of
														 * it (user: 滚动到底部的按钮有俩) and has been removed. */}
														{/* Message-tree navigation now lives in the chat head row
														 * (left of the session-info toggle), so it no longer
														 * overlays the transcript's first row. */}
														{/* In-message text selection actions:
														 * quote a snippet (not the whole message), quote it with a comment, copy,
														 * start a new session from it, or append it to the workspace notes. */}
														<SelectionToolbar
															containerRef={transcriptRef}
															onQuote={(text, _pdf, _office, comment, source) =>
																appendQuote(text, source?.messageId, comment, source?.anchor)
															}
															onAsk={(text, x, y) =>
																window.dispatchEvent(
																	new CustomEvent("musepi-gui-ask", { detail: { text, x, y } }),
																)
															}
															onCopy={text => void navigator.clipboard.writeText(text)}
															onNewSession={text => onSubmitNewSession(text)}
															onAddNote={text => {
																// v1.19 parity: each "add to notes" becomes its own
																// note (notes.create), never appended to the blob.
																const cwd = store.cwd;
																void rpc
																	.request("notes.create", { cwd, body: `> ${text}` })
																	.then(() => {
																		// The project-knowledge panel lists the same
																		// daemon notes; tell it to reload instead of
																		// waiting for a tab switch to re-mount it.
																		window.dispatchEvent(new CustomEvent("musepi-notes-changed"));
																	})
																	.catch(() => {});
															}}
														/>
														{/* Idle recap (TUI `※ recap:` status-line parity): the daemon
														 * generates it after recap.idleSeconds of quiet; a rounded
														 * floating card above the composer edge, foldable to one
														 * line (click to expand/collapse), cleared by the next
														 * wire activity or the dismiss button. */}
														{snap?.recap && (
															<div
																className={`gui-recap-row gui-liquid-glass${recapExpanded ? " gui-recap-row--expanded" : ""}`}
																title={recapExpanded ? t("tools.collapse") : t("tools.expand")}
																role="button"
																onClick={() => setRecapExpanded(v => !v)}
															>
																<span className="gui-recap-prefix">※</span>
																<span className="gui-recap-text">{snap.recap.text}</span>
																<span className="gui-recap-time">{relTime(snap.recap.at)}</span>
																<Icon
																	name="arrow-down-s"
																	className={`gui-recap-chevron${recapExpanded ? " gui-recap-chevron--open" : ""}`}
																/>
																<button
																	type="button"
																	className="gui-recap-dismiss"
																	title={t("settings.dismiss")}
																	aria-label={t("settings.dismiss")}
																	onClick={e => {
																		e.stopPropagation();
																		store?.dismissRecap();
																	}}
																>
																	<Icon name="close" className="h-3 w-3" />
																</button>
															</div>
														)}
														{/* Progressive-blur edge bands: THREE sibling backdrop
														 * layers per edge (2/6/14px, each masked to a shorter
														 * ramp) so blur strength grows toward the head/composer
														 * instead of an opaque slab hiding the rows. A mask on
														 * the scroller itself recomposited the whole transcript
														 * every frame; these bounded bands do not. The end band
														 * is still the composer-inset reader. */}
														<div aria-hidden="true" className="gui-chat-fade gui-chat-fade--top">
															{[1, 2, 3].map(step => (
																<span
																	key={step}
																	className={`gui-chat-fade-layer gui-chat-fade-layer--${step}`}
																/>
															))}
														</div>
														<div
															ref={registerComposerInsetReader}
															aria-hidden="true"
															className="gui-chat-fade gui-chat-fade--end"
														>
															{[1, 2, 3].map(step => (
																<span
																	key={step}
																	className={`gui-chat-fade-layer gui-chat-fade-layer--${step}`}
																/>
															))}
														</div>
													</>
												)}
											</div>
											{/* Turn-position rail: a marker per user message — hover previews
											 * the prompt, click jumps to that turn. In canvas mode
											 * the transcript scroller does not exist, so the rail
											 * switches to the active-path source below and clicks
											 * hand the node over to the map. */}
											<TurnRail
												rootRef={transcriptRef}
												entryCount={snap?.entries.length ?? 0}
												nodeTurns={viewMode === "canvas" ? canvasRail.turns : undefined}
												activeTurnIndex={viewMode === "canvas" ? canvasRail.activeIdx : null}
												onSelectNode={id => setCanvasFocus(prev => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))}
												turnsData={viewMode === "canvas" ? undefined : turnsData}
												onJumpToTurn={entryId => requestJump({ entryId })}
											/>
										</div>
										{/* ⌘F find bar: floats over the conversation's
										 * top edge. It is a child of .gui-chat-body — the chat column's own
										 * box, and therefore its offset parent. NOT .gui-transcript-wrap:
										 * the pause banner sits in flow
										 * above the wrap, so the two boxes differ, and an earlier revision
										 * wrongly assumed the wrap was the ancestor. Absolutely positioned
										 * on purpose: a bar in flow would re-measure every virtual row. */}
										{findOpen && (
											<ChatFind
												hits={findHits}
												index={findIndex}
												query={findQuery}
												searching={findSearching}
												onQuery={setFindQuery}
												onPrev={() => stepFind(-1)}
												onNext={() => stepFind(1)}
												onClose={closeFind}
												onJumpTo={jumpToHit}
											/>
										)}
										{/* Floating session info card — only the explicit reveal of a
										 * row too narrow to dock. INSIDE the chat body (never over
										 * the rail or the panel) and below the header row; z-index 3
										 * keeps it under menus and tooltips. Mounted through its exit
										 * window so closing fades instead of blinking out. */}
										{sessionInfoFloatPresence.mounted && (
											<SessionInfoCard
												{...sessionInfoCardProps}
												mode="float"
												/* The composer floats over the transcript (absolute, bottom 0),
												 * so it takes no flow space: the card is handed its height to
												 * cap itself above it. The card cannot read the published
												 * `--chat-composer-inset` — it is a sibling of the element that
												 * publishes it, not a descendant. */
												bottomInset={composerInset}
												closing={sessionInfoFloatPresence.closing}
											/>
										)}
									</div>
									{/* Docked session info column — the session's metadata as a
									 * workspace column beside the chat. It keeps its place while
									 * the panel is open as long as the row fits both, and folds
									 * to 0 (same spring as the panel) when it does not, so the
									 * card never changes seats. The wrapper stays in the row so
									 * opening and closing push/pull the chat column on one
									 * spring. */}
									{!focusMode && (
										<div
											className={`gui-session-info-seat${sessionInfoDockOpen ? "" : " gui-session-info-seat--closed"}`}
											inert={sessionInfoDockOpen ? undefined : true}
										>
											{sessionInfoDockPresence.mounted && (
												<SessionInfoCard {...sessionInfoCardProps} mode="dock" />
											)}
										</div>
									)}
								</div>
							</div>
						)}
						<div
							ref={composerHostRef}
							className="gui-composer-host"
							data-mode={store ? "session" : "welcome"}
							style={composerHostBox ?? undefined}
						>
							<div
								ref={composerWrapRef}
								className={
									focusMode
										? "gui-composer-wrap gui-composer-wrap--bottom-anchor flex min-h-0 flex-col px-5 pb-3"
										: store
											? "gui-composer-wrap gui-composer-wrap--floating flex flex-col px-5 pb-1"
											: "gui-composer-wrap gui-composer-wrap--hero flex min-h-0 flex-1 flex-col justify-center"
								}
							>
								{/* Jump-back dock (TUI navigateTree parity, 2026-08-25):
								 * a floating card above the input — shows the target of the
								 * last 撤回 (non-destructive branchAt leaf move) with an
								 * explicit undo (jump back to the leaf we came from; the
								 * old tail stays on the tree as a sibling branch either
								 * way). Lives OUTSIDE the transcript so it never scrolls
								 * away; appears/disappears and expands with the shared
								 * Reveal motion (fade + collapse). */}
								<Reveal open={jumpBack !== null}>
									<div className="gui-revert-dock" role="region" aria-label={t("general.jumpedBack")}>
										<div
											role="button"
											tabIndex={0}
											className="gui-revert-dock-head"
											onClick={() => setJumpDockOpen(v => !v)}
											onKeyDown={e => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													setJumpDockOpen(v => !v);
												}
											}}
											aria-expanded={jumpDockOpen}
										>
											<Icon
												name="arrow-go-back"
												className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-warning)]"
											/>
											<span className="gui-revert-dock-title" title={jumpBack?.text}>
												{jumpBack
													? t("general.jumpedBack2") + (jumpBack.text ? `: ${jumpBack.text}` : "")
													: t("general.jumpedBack")}
											</span>
											<button
												type="button"
												className="gui-pane-action !w-auto px-1.5"
												title={t("general.undoJump")}
												onClick={e => {
													// The head is a click target for collapse/expand —
													// don't toggle it when the undo button fires.
													e.stopPropagation();
													void undoJumpBack();
												}}
											>
												<Icon name="arrow-go-forward" className="h-3 w-3" />
											</button>
											<button
												type="button"
												className="gui-pane-action !w-auto px-1.5"
												title={t("settings.close")}
												onClick={e => {
													// #12: dismiss the dock but STAY at the reverted
													// position — the sibling branch stays on the tree,
													// reachable again via the breadcrumb or the row
													// buttons. The undo button above keeps its role.
													e.stopPropagation();
													setJumpBack(null);
													setJumpDockOpen(false);
												}}
											>
												<Icon name="close" className="h-3 w-3" />
											</button>
											<Icon
												name="arrow-down-s"
												className={`gui-revert-dock-chevron${jumpDockOpen ? " gui-revert-dock-chevron--open" : ""}`}
												aria-hidden="true"
											/>
										</div>

										<Reveal open={jumpDockOpen}>
											<div className="gui-revert-dock-body">
												<div className="gui-revert-item">
													<span className="gui-revert-item-text" title={jumpBack?.text}>
														{jumpBack?.text ?? ""}
													</span>
												</div>
												<p className="gui-revert-hint">{t("general.jumpBackHint")}</p>
											</div>
										</Reveal>
									</div>
								</Reveal>
								{/* Session-level failure dock: a round the runtime gave up on, or one
								 *  that produced neither a reply nor an error. Docked above the composer
								 *  rather than in the message flow, and cleared by the next send. */}
								{!readOnly && (
									<SessionErrorDock
										entries={visibleEntries}
										working={snap?.working ?? false}
										verifyTranscript={verifyTranscript}
									/>
								)}
								{snap?.approvals.map(a => (
									<ApprovalCard
										key={a.requestId}
										requestId={a.requestId}
										tool={a.tool}
										prompt={a.prompt}
										onDecide={onDecideApproval}
									/>
								))}
								{secretRequests.map(request => (
									<SecretCard
										key={request.requestId}
										request={request}
										onAnswer={answerSecret}
										onSettled={requestId => {
											answeredSecretRequestsRef.current.delete(requestId);
											setSecretRequests(current => current.filter(item => item.requestId !== requestId));
										}}
									/>
								))}
								{mcpAuth && onMcpAuthAuthorize && onMcpAuthCancel && onMcpAuthDismiss && (
									<div className="gui-mcp-auth-wrap">
										<McpAuthCard
											request={mcpAuth}
											state={mcpAuth.state}
											error={mcpAuth.error}
											onAuthorize={onMcpAuthAuthorize}
											onCancel={onMcpAuthCancel}
											onDismiss={onMcpAuthDismiss}
										/>
									</div>
								)}
								{ask && onAskAnswer && (
									<div className="gui-ask-float" ref={askFloatRef}>
										<AskCard ask={ask} onAnswer={answer => onAskAnswer(answer)} />
									</div>
								)}
								{/* Layer-1 session-tree nav chrome: breadcrumb path + fork hint
								 * above the composer (root > … > leaf, click any segment to jump). */}
								{currentLeafKey !== null && (
									<SessionTreeNav
										segments={breadcrumb}
										activeLeafIsHistorical={leafChildren.length > 0}
										activeLeafLabel={labelOf({ id: effectiveLeaf ?? "" }, t("transcript.thisNode"))}
										onJump={id => {
											// /tree parity: 点击路径段 = 切换 leaf 到该节点
											// (旧尾部保留为 sibling branch),非仅滚动。
											switchToNode(id);
										}}
									/>
								)}
								{store ? (
									readOnly ? (
										<div className="gui-readonly-bar" role="note">
											<Icon name="sparkling" className="h-3.5 w-3.5" />
											<span>{t("general.advisorTranscriptReadonly")}</span>
										</div>
									) : sessionComposerProps ? (
										<SlotComponentHost
											rpc={rpc}
											slot={COMPOSER_BAR_SLOT}
											composer={sessionComposerProps}
											fallback={<Composer {...sessionComposerProps} />}
										/>
									) : null
								) : (
									<SlotComponentHost
										rpc={rpc}
										slot={COMPOSER_BAR_SLOT}
										composer={heroComposerProps}
										fallback={<Composer {...heroComposerProps} />}
									/>
								)}
							</div>
						</div>
					</div>
					{/* Right panel stays mounted so the width collapse animates;
					 * `open` folds it to a 0px sliver instead of unmounting. The
					 * mini window has no workspace chrome: no rail, no panel. */}
					{!mini && panelShellMounted.current && (
						<SlotComponentHost
							slot={PANEL_SHELL_SLOT}
							rpc={rpc}
							panelShell={{
								snap,
								rpc,
								cwd: store?.cwd ?? project ?? "",
								open: rightPanelOpen && !focusMode,
								openRequest: openFileReq,
								browserOpenRequest: openBrowserReq,
								// Takeover is an ownership handoff: the managed-browser side
								// refuses further agent commands on the tab. It must NOT stop
								// the turn — the agent continues and reads the refusal.
								onViewChange: setActiveView,
								panelTabs,
								onExpandPanel: onExpandRightPanel,
								// Only fold while it is actually open: a toggle would EXPAND a
								// folded panel, which is the opposite of what an empty tab set means.
								onCollapsePanel: () => {
									if (rightPanelOpen) onToggleRightPanel?.();
								},
								agentId: panelAgentId,
								onAgentSelect: selectAgent,
								onOpenSession,
								onNewSession: text => onSubmitNewSession(text),
								agentHost: host,
								extTabs,
								overviewEntries,
								overviewLoading: snap?.historyLoading === true,
								overviewError: store?.historyBlocked ?? false,
								onLoadOlderHistory: onLoadOlderStable,
								onJumpToEntry: entryId => requestJump({ entryId }),
								leafId: effectiveLeaf,
								activePathIds: trustedPathIds,
								pathEntries: pathEntriesOrNull,
								modeCatalog: modes,
								onOpenSettings,
								onAddProvider,
								planShowRequest,
								onBranchTo: id => {
									// Same question as the map and the transcript row: the
									// panel's re-answer moves the leaf exactly like 撤回.
									const quote = userMessageText(snap?.entries.find(entry => entry.id === id));
									void withdrawSettled(quote, async () => {
										const res = await branchTo(id, id);
										if (res?.editorText) setPendingEdit({ text: res.editorText });
									});
								},
								onSwitchTo: id => {
									setPendingEdit(null);
									void switchToNode(id, { backfillDraft: false });
								},
								onForkAt: id => {
									const entry = snap?.entries.find(e => e.id === id);
									const isUser = entry?.type === "message" && entry.message.role === "user";
									void forkFromMessage(id, undefined, !isUser);
								},
							}}
						/>
					)}
					{/* Right-edge 44px icon rail: tool icons + panel fold toggle +
					 * extension rail.right slot. Sibling of the panel at the
					 * surface's right edge.
					 *
					 * Deliberately OUTSIDE the panelShellMounted latch below: that
					 * latch only arms once the panel has been open, so mounting the
					 * rail with it left a panel that started collapsed with NO way
					 * to reopen it — the rail is the reopen affordance, so it has
					 * to exist precisely when the panel does not. */}
					{!mini && (
						<RightRail
							sessionId={store?.sessionId ?? null}
							cwd={store?.cwd ?? project ?? ""}
							rpc={rpc}
							openSurfaces={openSurfaces}
							rightPanelOpen={rightPanelOpen && !focusMode}
							terminalOpen={terminalOpen}
							onToggleTerminal={onToggleTerminal}
							extTabs={extTabs}
							onSelect={id => {
								// Same view while open → collapse (Chrome side-panel
								// semantics); otherwise select and expand.
								if (id === activeView && rightPanelOpen && !focusMode) {
									onToggleRightPanel?.();
									return;
								}
								setActiveView(id);
								if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
							}}
							onSelectNew={id => {
								// M1.12: middle-click / ⌘-click means "another one of
								// these" — a new instance, not a focus. The panel also
								// has to be showing for a second instance to be
								// reachable, so this expands rather than folds.
								if (id === "browser") openBrowserPanel(true);
								else panelTabs.open({ surface: id, label: tabLabelFor(id) }, { forceNew: true });
								if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
							}}
							onToggleRightPanel={onToggleRightPanel}
						/>
					)}
				</div>
				{btwQuestion !== null && !focusMode && (
					<BtwFloatingCard
						initialQuestion={btwQuestion}
						onAsk={(question, history) => {
							const sessionId = store?.sessionId;
							if (!rpc || !sessionId) return Promise.resolve(null);
							// Rebuild a self-contained prompt that carries the
							// conversation context: prior turns are prepended so
							// follow-ups see the same thread (ephemeralAsk is
							// stateless — no transcript write).
							const ctx = history.map(h => `Q: ${h.question}\nA: ${h.answer}`).join("\n\n");
							const promptText = ctx
								? `Context:\n${ctx}\n\nNew question:\n${question}\n\nAnswer the new question in the context above.`
								: question;
							return rpc
								.request<{ replyText?: string } | null>("session.ephemeralAsk", {
									sessionId,
									promptText,
								})
								.then(res => (res?.replyText ? { replyText: res.replyText } : null));
						}}
						onBranch={async (question: string, replyText: string): Promise<boolean> => {
							const sessionId = store?.sessionId;
							if (!rpc || !sessionId) return true;
							try {
								const res = await rpc.request<{ ok?: boolean } | null>("session.btwBranch", {
									sessionId,
									question,
									replyText,
								});
								// Promote = close the card; the new session appears
								// in the sidebar (session list refreshes via tree).
								if (res?.ok === true) setBtwQuestion(null);
							} catch {
								// daemon rejected (busy/guard) — keep the card open
							}
							return true;
						}}
						onClose={() => setBtwQuestion(null)}
					/>
				)}
				{/* Terminal dock: the shell stays MOUNTED so open/close animates
				 * (height 0 ↔ dockHeight). The TerminalPanel inside mounts on the
				 * first dock open and then persists across session switches —
				 * folding the dock hides it without killing the pties, so a
				 * switch-and-return finds the same terminals with scrollback
				 * intact. */}
				<div
					ref={terminalDockRef}
					className={`gui-terminal-dock relative flex flex-shrink-0 flex-col overflow-hidden${
						terminalOpen ? " gui-terminal-dock--open" : ""
					}${terminalPlacement === "right" ? " gui-terminal-dock--right" : ""}`}
					style={{
						height: terminalPlacement === "right" ? (terminalOpen ? "100%" : 0) : terminalOpen ? dockHeight : 0,
						...(terminalPlacement === "right" ? { width: terminalOpen ? rightWidth : 0 } : {}),
					}}
				>
					{/* Dock grips: both seams mount the shared pill on the dock's own
					 * edge band, and `.gui-terminal-dock--resizing` (set by the
					 * drags above) drives its drag state. A folded dock hides both
					 * handles, so the seam never needs a border to advertise it. */}
					<div
						className="gui-dock-handle"
						{...dockResizeDrag}
						style={{ touchAction: "none" }}
						role="separator"
						aria-orientation="horizontal"
						aria-label={t("settings.resizeTerminalDock")}
						tabIndex={0}
						onKeyDown={event => {
							const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
							if (direction === 0) return;
							event.preventDefault();
							nudgeDockHeight(direction, event.shiftKey);
						}}
					>
						<SplitterGrip orientation="horizontal" />
					</div>
					{terminalPlacement === "right" && (
						<div
							className="gui-terminal-right-handle"
							{...rightDockResizeDrag}
							style={{ touchAction: "none" }}
							role="separator"
							aria-orientation="vertical"
							aria-label={t("settings.resizeTerminalDock")}
							tabIndex={0}
							onKeyDown={event => {
								const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
								if (direction === 0) return;
								event.preventDefault();
								nudgeDockRightWidth(direction, event.shiftKey);
							}}
						>
							<SplitterGrip />
						</div>
					)}
					{terminalPanelMounted && (
						<TerminalPanel rpc={rpc} cwd={store?.cwd ?? project ?? ""} onAllClosed={onCloseTerminal} />
					)}
				</div>
			</div>
			{/* 保存为图片 export dialog (always mounted — DialogFrame drives its
			 * own enter/exit animation via `open`). */}
			<SaveImageDialog
				open={saveImageText !== null}
				text={saveImageText ?? ""}
				onClose={() => setSaveImageText(null)}
			/>
			<SessionArtifactPreviewDialog rpc={rpc} request={artifactPreview} onClose={() => setArtifactPreview(null)} />
		</main>
	);
}

/** Host-owned session surface contract injected through the main.conversation slot. */
export type ChatViewProps = Parameters<typeof ChatView>[0];
