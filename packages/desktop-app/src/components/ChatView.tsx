import {
	buildTurnIndex,
	CodeHighlightProvider,
	downloadBlob,
	punkAvatarUri,
	relTime,
	Transcript,
	type TranscriptAnchor,
	type TranscriptAnchorCtl,
	type TranscriptNodeInjection,
	type TranslationKey,
	type TurnIndexItem,
	t,
} from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type GitUser, readGitUser } from "../lib/git-user";
import { useChatHighlight } from "../lib/highlight";
import { dispatchNotification } from "../lib/notify";
import { moodFromState, orbFromSession, stateFromSignals } from "../lib/pet";
import { useConfirm } from "../lib/prompt-dialog";
import { rasterizeToBlob } from "../lib/rasterize";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionStore } from "../lib/session-store";
import {
	PANEL_TAB_SLOT_PREFIX,
	SlotComponentMount,
	selectTranscriptNodeComponents,
	TRANSCRIPT_NODE_SLOT,
	useExtensionToolViews,
	useSlotComponents,
	useSlotComponentsByPrefix,
} from "../lib/slot-host";
import { surfaceById } from "../lib/surfaces/registry";
import { usePanelTabs } from "../lib/use-panel-tabs";
import { usePointerDrag } from "../lib/use-pointer-drag";
import { useStore } from "../lib/use-store";
import { speak } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";
import { ApprovalCard } from "./ApprovalCard";
import { type AskAnswer, AskCard, type AskRequest } from "./AskCard";
import { AskPopover } from "./AskPopover";
import { PunkAvatar } from "./avatar-presets";
import { BrowserGuiHint } from "./BrowserGuiHint";
import { BtwFloatingCard } from "./BtwFloatingCard";
import { Composer } from "./Composer";
import { ContextPanel } from "./ContextPanel";
import { MessageTreeButton } from "./MessageTree";
import type { ReminderRow } from "./RemindersPanel";
import { Reveal } from "./Reveal";
import { RightRail } from "./RightRail";
import { SaveImageDialog } from "./SaveImageDialog";
import { SelectionToolbar } from "./SelectionToolbar";
import { type BreadcrumbSegment, SessionTreeNav } from "./SessionTreeNav";
import { StatusCards } from "./StatusCards";
import { SessionStatusBar } from "./statusbar-info";
import { TerminalPanel } from "./TerminalPanel";
import type { ThinkingLevel } from "./ThinkingSelector";
import { TurnMapCanvas } from "./TurnMapCanvas";
import { TurnRail } from "./TurnRail";
import { WelcomeComposer } from "./WelcomeComposer";

/** session.history 分页响应(ensureFullHistory 全量补全的循环形态)。 */
interface HistoryPage {
	entries: SessionEntry[];
	hasMore: boolean;
	remaining: number;
}

/** "mm:ss" hold time for the pause banner; re-rendered by a 1s tick. */
function formatPauseElapsed(pausedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - pausedAt) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * User gutter avatar — GitHub avatar (synced by the settings Git tab via
 * `musepi-gui-user-avatar`, `https://github.com/<login>.png`) with the git
 * identity's initial as fallback; the title carries the git name/email
 * (falls back to the generic user chip).
 */
function UserAvatar({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [user, setUser] = useState<GitUser | null>(null);
	const [avatarFailed, setAvatarFailed] = useState(false);
	// Synchronous read: every message bubble renders one of these — a per-
	// instance RPC would fan out; localStorage is set by the Git tab.
	const avatarUrl = (() => {
		try {
			return localStorage.getItem("musepi-gui-user-avatar") || null;
		} catch {
			return null;
		}
	})();
	useEffect(() => {
		let cancelled = false;
		void readGitUser(rpc, cwd).then(u => {
			if (!cancelled) setUser(u);
		});
		return () => {
			cancelled = true;
		};
	}, [rpc, cwd]);
	useEffect(() => {
		setAvatarFailed(false);
	}, []);
	// Avatar source mode (设置 → 通用 → 用户头像来源): auto = GitHub →
	// pixel face → initial; punk = always the deterministic pixel face;
	// initial = letter chip only (no network, no pixel). Listens to
	// omp-avatar-changed so a settings change applies immediately.
	const readMode = (): string => {
		try {
			return localStorage.getItem("musepi-gui-user-avatar-mode") ?? "auto";
		} catch {
			return "auto";
		}
	};
	const [avatarMode, setAvatarMode] = useState<string>(readMode);
	useEffect(() => {
		const on = (): void => setAvatarMode(readMode());
		window.addEventListener("omp-avatar-changed", on);
		window.addEventListener("storage", on);
		return () => {
			window.removeEventListener("omp-avatar-changed", on);
			window.removeEventListener("storage", on);
		};
	}, []);
	const initial = user?.name?.trim().charAt(0)?.toLocaleUpperCase() ?? "";
	const title = user ? (user.email ? `${user.name} <${user.email}>` : user.name) : t("you");
	const punkFace = user?.name?.trim() ? (
		<img src={punkAvatarUri(user.name.trim())} alt="" className="gui-user-avatar-img gui-avatar-punk" />
	) : null;
	const letterFace = initial ? <span className="gui-user-avatar-letter">{initial}</span> : null;
	return (
		<span className="gui-user-avatar" title={title}>
			{avatarMode === "initial" ? (
				(letterFace ?? <Icon name="user" className="h-3.5 w-3.5" />)
			) : avatarMode === "punk" ? (
				/* Explicit pixel-face mode: the user-chosen seed (设置 → 常规
				 * 换一个 / seed 输入, PUNK_SEED_KEY) — NOT the git-identity
				 * face, so the chat bubble follows the settings control and
				 * never degrades to a blank icon when git identity is absent.
				 * PunkAvatar listens for omp-avatar-changed, so 换一个/apply
				 * re-renders every mounted bubble live. */
				<PunkAvatar size={20} />
			) : avatarUrl && !avatarFailed ? (
				<img src={avatarUrl} alt="" className="gui-user-avatar-img" onError={() => setAvatarFailed(true)} />
			) : (
				(punkFace ?? letterFace ?? <Icon name="user" className="h-3.5 w-3.5" />)
			)}
		</span>
	);
}

/**
 * Center pane — ONE rounded floating surface hosting two scenes:
 *  - welcome (no session): greeting, watermark, centered composer with
 *    border-beam glow; fades/zooms out when a session appears.
 *  - session: header (title/status + terminal & right-panel toggles in
 *    the top-right, ZCode style), transcript with the session-bound
 *    ContextPanel nested beneath it, bottom composer, optional dock.
 *
 * ZCode immersive layout: the session-bound right panel lives INSIDE this
 * surface; the global session sidebar stays a separate full-height pane
 * whose controls float on the boundary next to this surface.
 */
// Measure the outgoing frame and transform the incoming one onto it,
// then transition back to identity (gui-flip-morph transition). Runs
// in the layout phase so no un-morphed frame ever paints. Module-scope:
// pure DOM work, no component state to close over.
function morphFrame(
	fromSel: string,
	toSel: string,
	fromRect?: { left: number; top: number; width: number; height: number } | null,
): void {
	const to = document.querySelector<HTMLElement>(toSel);
	if (!to) return;
	// The incoming frame animates FROM the outgoing anchor's rect — hide
	// that anchor while it morphs, or the original double-paints as a
	// fading copy next to the flying one (most visible welcome→session,
	// where the big welcome composer + dot-matrix brand fade out).
	const fromEl = document.querySelector<HTMLElement>(fromSel);
	if (fromEl) fromEl.style.opacity = "0";
	const from = fromRect ?? fromEl?.getBoundingClientRect() ?? null;
	if (!from) {
		if (fromEl) fromEl.style.opacity = "";
		return;
	}
	const b = to.getBoundingClientRect();
	if (from.width === 0 || b.width === 0 || from.height === 0) return;
	const dx = from.left - b.left;
	const dy = from.top - b.top;
	const sx = from.width / b.width;
	const sy = from.height / b.height;
	// Web Animations API (same as the focus morph): a transition on the
	// class needs the offset transform to actually paint a frame first —
	// under headless (and on fast compositors) the class-toggle rAF dance
	// can collapse into one frame and the morph snaps. An explicit
	// animation always plays its timeline.
	//
	// Motion smoothness: a long-distance scale morph reads as choppy
	// (each frame moves a lot and the mid-scale text shimmers). Five
	// keyframes distribute the travel into short linear segments — each
	// frame then moves little, so the flight looks continuous — and the
	// blur ramp (heavy while fast, clear on landing) fakes motion blur
	// over the mid-scale shimmer.
	const t = (k: number) => `translate(${dx * k}px, ${dy * k}px) scale(${1 + (sx - 1) * k}, ${1 + (sy - 1) * k})`;
	to.animate(
		[
			{ transform: t(1), transformOrigin: "top left", filter: "blur(7px)" },
			{ transform: t(0.8), transformOrigin: "top left", filter: "blur(4px)" },
			{ transform: t(0.55), transformOrigin: "top left", filter: "blur(2.5px)" },
			{ transform: t(0.28), transformOrigin: "top left", filter: "blur(1px)" },
			{ transform: "translate(0px, 0px) scale(1, 1)", transformOrigin: "top left", filter: "blur(0px)" },
		],
		{ duration: 580, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
	);
}

/** Last-seen session composer rect — the reverse morph (session → welcome)
 * needs it after the chat scene unmounted. */
let lastSessionFrameRect: { left: number; top: number; width: number; height: number } | null = null;
/** Last-seen welcome composer rect — symmetric warm cache for the
 * welcome → session morph: the welcome scene is mid-fade when the chat
 * scene mounts, so a live measure at that moment is unstable; the
 * steady-state rect (captured during showWelcome renders) is not. */
let lastWelcomeFrameRect: { left: number; top: number; width: number; height: number } | null = null;

export function ChatView({
	store,
	rpc,
	onSend,
	onStop,
	onDecideApproval,
	onReloadSession,
	onForkSession,
	presetModelId,
	modes,
	modeId,
	onModeChange,
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
	focusMode,
	onToggleFocus,
	paused,
	pausedAt,
	onResume,
	reminders,
	onSelectReminder,
	onMarkAllRead,
	sessionLoading,
	ask,
	onAskAnswer,
}: {
	store: GuiSessionStore | null;
	rpc: RpcClient;
	onSend(
		text: string,
		images?: { type: "image"; data: string; mimeType: string }[],
		deliverAs?: "prompt" | "steer" | "followUp",
	): void;
	onStop(): void;
	onDecideApproval(requestId: string, approved: boolean, note?: string): void;
	/** Reload the active session snapshot (revert/edit truncation). */
	onReloadSession?(): Promise<void> | void;
	/** Open a forked session (session.forkAt result) — switches the UI to
	 *  the new branch and refreshes the tree. */
	onForkSession?(sessionId: string): Promise<void> | void;
	/** Model chosen in the welcome composer before the session existed —
	 *  carried into the session composer as its initial seed. */
	presetModelId?: string | null;
	/** Welcome 预设(mode)chip(welcome 场景;modes 未传则不渲染,见 Composer)。 */
	modes?: { id: string; label: string }[] | null;
	modeId?: string | null;
	onModeChange?(id: string | null): void;
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
	/** Session-bound right panel (context/files/terminal tools), ZCode
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
	/** Focus mode (openchamber ⌘⇧E): composer fills the surface. */
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
	/** Pending ask question (TUI ask parity): the daemon pushed an
	 *  ask-request envelope — the floating card above the composer answers
	 *  via onAskAnswer (session.askAnswer). */
	ask?: AskRequest | null;
	onAskAnswer?(answer: AskAnswer): void;
}): ReactNode {
	const noopSubscribe = (): (() => void) => () => {};
	const snap = useStore(
		store ? store.subscribe.bind(store) : noopSubscribe,
		store ? store.getSnapshot.bind(store) : () => null,
	);
	// 扩展 per-tool 渲染器(registerToolView — DSH tool.call.toolview):
	// 注册进 guest-client tool-render 外部表,transcript 按工具名分派。
	useExtensionToolViews(rpc);
	// Pause banner hold timer: tick every second while the freeze is engaged
	// so the "paused · mm:ss" clock advances.
	const [, setPauseTick] = useState(0);
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
	// settings-panel commits (SchemaSettings dispatches
	// omp-settings-changed). settings.get returns schema defaults, so
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
						"display.taskCardStyle",
						"tts.autoRead",
						"tts.rate",
						"tts.inputMode",
					],
				})
				.then(v => {
					if (alive) setDisplaySettings(v ?? {});
				})
				.catch(() => {});
		};
		load();
		window.addEventListener("omp-settings-changed", load);
		return () => {
			alive = false;
			window.removeEventListener("omp-settings-changed", load);
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
	// TTS 自动朗读(tts.autoRead):空闲时检测新的 settled assistant 消息并朗读。
	const lastAutoReadIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (displaySettings["tts.autoRead"] !== true) return;
		if (!snap || snap.working || snap.streaming) return;
		let lastId: string | null = null;
		let lastText = "";
		for (let i = snap.entries.length - 1; i >= 0; i--) {
			const e = snap.entries[i];
			if (e.type === "message" && e.message.role === "assistant" && !e.message.duration) continue;
			if (e.type === "message" && e.message.role === "assistant") {
				lastId = e.id;
				lastText = (e.message.content as { type?: string; text?: string }[])
					.filter(block => block.type === "text")
					.map(block => block.text ?? "")
					.join(" ");
				break;
			}
		}
		if (!lastId || lastId === lastAutoReadIdRef.current) return;
		lastAutoReadIdRef.current = lastId;
		if (!lastText.trim()) return;
		stopSpeakRef.current = speak(
			lastText,
			rpc,
			{
				rate: typeof displaySettings["tts.rate"] === "number" ? (displaySettings["tts.rate"] as number) : undefined,
				// Same content-mode contract the TTS test card uses: anything
				// but "raw"/"summarize" (unset, "sanitize", garbage) keeps
				// speak()'s default sanitize behavior.
				mode:
					displaySettings["tts.inputMode"] === "raw" || displaySettings["tts.inputMode"] === "summarize"
						? displaySettings["tts.inputMode"]
						: undefined,
			},
			activity => {
				if (activity.phase === "speaking") setSpeakingId(lastId);
				else if (activity.phase === "done" || activity.phase === "stopped") {
					stopSpeakRef.current = null;
					setSpeakingId(prev => (prev === lastId ? null : prev));
				} else if (activity.phase === "error") {
					stopSpeakRef.current = null;
					setSpeakingId(prev => (prev === lastId ? null : prev));
					dispatchNotification("error", { lastMessage: activity.message });
				}
			},
		);
		setSpeakingId(lastId);
	}, [snap, displaySettings["tts.autoRead"], displaySettings["tts.rate"], displaySettings["tts.inputMode"], rpc]);
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
	// Desktop-only tree-sitter highlighting for transcript code blocks.
	const chatHighlight = useChatHighlight();
	useEffect(() => {
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
	// FLIP morph: when a scene ENTERS (its DOM actually mounted — the
	// showChat/showWelcome flags can flip before the store populates the
	// scene, so ref callbacks below are the reliable trigger; a
	// flag-diff-based layout effect misses that window), morph its
	// composer frame from the outgoing scene's frame rect (both are
	// mounted in the overlap window).
	const sceneMorphPend = useRef<{
		to: string;
		from: string;
		fromRect?: { left: number; top: number; width: number; height: number } | null;
	} | null>(null);
	const sceneMorphScheduled = useRef(false);
	const sceneMorph = (
		fromSel: string,
		toSel: string,
		fromRect?: { left: number; top: number; width: number; height: number } | null,
	): void => {
		sceneMorphPend.current = { to: toSel, from: fromSel, fromRect };
		if (sceneMorphScheduled.current) return;
		sceneMorphScheduled.current = true;
		// Defer past the commit so both scenes are laid out; the frame
		// rects (and the outgoing scene's existence) are then reliable.
		requestAnimationFrame(() => {
			sceneMorphScheduled.current = false;
			const pend = sceneMorphPend.current;
			sceneMorphPend.current = null;
			if (pend) morphFrame(pend.from, pend.to, pend.fromRect);
		});
	};
	const welcomeSceneRef = (el: HTMLDivElement | null): void => {
		if (el) {
			sceneMorph('[data-flip-anchor="session"]', '[data-flip-anchor="welcome"]', lastSessionFrameRect);
			lastSessionFrameRect = null;
		}
	};
	const chatSceneRef = (el: HTMLDivElement | null): void => {
		if (el) {
			sceneMorph('[data-flip-anchor="welcome"]', '[data-flip-anchor="session"]', lastWelcomeFrameRect);
			lastWelcomeFrameRect = null;
		}
	};
	// While the chat scene is mounted, keep the composer frame's rect warm
	// for the reverse morph (session → welcome): the ref callback for the
	// incoming welcome scene runs before the unmounting chat scene is
	// measurable, so the rect is captured here, during render (same
	// measurement pattern as the welcome composer's prevSize).
	if (showChat) {
		const frame = document.querySelector<HTMLElement>('[data-flip-anchor="session"]');
		if (frame) {
			const r = frame.getBoundingClientRect();
			if (r.width > 0) lastSessionFrameRect = { left: r.left, top: r.top, width: r.width, height: r.height };
		}
	}
	// Symmetric warm cache for the welcome composer: capture its rect in
	// steady state so the welcome → session morph starts from a stable
	// position instead of a live measure taken while the welcome scene is
	// mid-fade (which jumps).
	if (showWelcome) {
		const frame = document.querySelector<HTMLElement>('[data-flip-anchor="welcome"]');
		if (frame) {
			const r = frame.getBoundingClientRect();
			if (r.width > 0) lastWelcomeFrameRect = { left: r.left, top: r.top, width: r.width, height: r.height };
		}
	}
	// Agent status via the thinking-orb state (ZCode: avatar, not labels).
	// streaming = the assistant message has started streaming (view folds it
	// into entries at message_start — no separate ghost is kept). Pending
	// tool approvals pin `waiting` (the "paused for you" wave) — shared
	// helper with the header so both avatars tell the same story.
	const orb = orbFromSession(snap);
	// Avatar display toggle lives in Settings → appearance (musepi-gui-avatars).
	const showAvatars = localStorage.getItem("musepi-gui-avatars") !== "0";
	// Resizable terminal dock (drag the top edge).
	const [dockHeight, setDockHeight] = useState(176);
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
			const h = Math.min(480, Math.max(96, dockStartRef.current - dy));
			setDockHeight(h);
		},
		onDragEnd: () => {
			terminalDockRef.current?.classList.remove("gui-terminal-dock--resizing");
		},
	});
	const terminalDockRef = useRef<HTMLDivElement | null>(null);
	const transcriptRef = useRef<HTMLDivElement | null>(null);
	// Jump requests (message tree / trajectory / canvas / branch bar): the
	// Transcript owns window expansion — a jump into the folded window
	// mounts the target row first, then scrolls + flashes (previously the
	// raw querySelector missed unmounted rows and fell back to scrollTop 0).
	const [jumpRequest, setJumpRequest] = useState<{ timestamp: string; nonce: number } | null>(null);
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
		const timer = setTimeout(() => {
			if (el) delete el.dataset.switched;
		}, 700);
		return () => clearTimeout(timer);
	}, [store?.sessionId, store]);
	// ZCode 引用回复 / Cmd+L 追加引用: quoted texts prepend the next
	// composer message; multiple quotes append as stacked cards.
	const [quotes, setQuotes] = useState<string[]>([]);
	const appendQuote = useCallback((text: string): void => {
		setQuotes(q => (q.includes(text) ? q : [...q, text]));
	}, []);
	// Global Cmd+L (app.tsx) lands here through the shared window event —
	// identical style to the toolbar 引用 button (quote cards), unlike the
	// old fenced-code insert.
	useEffect(() => {
		const onQuoteAppend = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string }>).detail;
			if (detail?.text) appendQuote(detail.text);
		};
		window.addEventListener("musepi-gui-quote-append", onQuoteAppend);
		return () => window.removeEventListener("musepi-gui-quote-append", onQuoteAppend);
	}, [appendQuote]);
	// File-reveal requests from transcript paths / artifact cards: relayed
	// into the ContextPanel → FilePane preview. nonce re-triggers the same
	// path (re-click while already open).
	const [openFileReq, setOpenFileReq] = useState<{ path: string; nonce: number } | null>(null);
	// External browser reveal (chat link click → managed browser, proma
	// AgentBrowserLinkProvider parity). nonce re-triggers the same URL.
	const [openBrowserReq, setOpenBrowserReq] = useState<{ url: string; nonce: number } | null>(null);
	// Active right-panel view — TAB-PRIMARY (docs/archive/gui-right-panel-redesign.md
	// §3.3.2, supersedes the "single navigation axis" model): one panel-level
	// tab strip hosts every open surface, and the rail opens-or-focuses tabs
	// instead of swapping the panel body. `activeView` is DERIVED from the
	// active tab's surface so every existing setActiveView call site keeps its
	// exact meaning — it now upserts a tab rather than mutating one variable.
	const panelTabs = usePanelTabs(`musepi-gui-panel-tabs-${store?.cwd ?? ""}`);
	const activePanelTab = panelTabs.tabs.find(t => t.id === panelTabs.activeId) ?? null;
	const activeView = activePanelTab?.surface ?? null;
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
	// 地图单一投影:轮级(0.5.0-map-redesign——节点 = 轮,164 轮 = 164 张卡)。
	// 消息级画布(SessionTreeCanvas)已下线:两套同数据源视图收敛为一个轮级
	// 地图,消息级分支结构由 ContextPanel 的 TrajectoryView 分支树模式承担。
	// Extension panel-tab slots (panel.tab.*) — nav items live in the rail;
	// the panel only renders their content.
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
	const setActiveView = useCallback(
		(view: string | null): void => {
			// null = "nothing selected"; the empty state owns that, the rail and
			// the strip never navigate to it.
			if (!view) return;
			// Strip label: registry display name for built-ins, the slot's own
			// label for extension tabs (openchamber tab-label parity) — a raw
			// surface id like "ext:settings" must never reach the tab title.
			const ext = view.startsWith("ext:") ? extTabsRef.current.find(x => `ext:${x.slot}` === view) : undefined;
			const label = ext ? (ext.label ?? ext.slot) : t((surfaceById(view)?.label ?? view) as TranslationKey);
			panelTabs.open({ surface: view, label });
		},
		[panelTabs.open],
	);
	// transcript.node seat dispatch (DSH `conversation.chat.node` entryKey
	// analog): extensions register renderers for specific node kinds
	// (transcriptNodeKind). A matched renderer OWNS the entry's rendering
	// (may include the built-in children base or render fully custom);
	// unregistered kinds fall through to the built-in (DSH fallback).
	// Memoized: the identity is part of EntryRow's memo comparison, and the
	// component set changes only on extensions.changed — not on stream frames.
	const transcriptNodeComponents = useSlotComponents(rpc, TRANSCRIPT_NODE_SLOT);
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
			const detail = (ev as CustomEvent<{ path?: string }>).detail;
			const path = detail?.path;
			if (typeof path !== "string" || !path) return;
			setOpenFileReq(prev => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
			onOpenFileInPanel?.(path);
		};
		window.addEventListener("omp-open-file", onOpenFile);
		return () => window.removeEventListener("omp-open-file", onOpenFile);
	}, [onOpenFileInPanel]);
	// External browser reveal (chat link click → managed browser).
	useEffect(() => {
		const onOpenUrl = (ev: Event): void => {
			const detail = (ev as CustomEvent<{ url?: string }>).detail;
			const url = detail?.url;
			if (typeof url !== "string" || !url) return;
			setOpenBrowserReq(prev => ({ url, nonce: (prev?.nonce ?? 0) + 1 }));
		};
		window.addEventListener("omp-open-url", onOpenUrl);
		return () => window.removeEventListener("omp-open-url", onOpenUrl);
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
	const setThinking = (level: ThinkingLevel | null): void => {
		if (!store) return;
		void rpc
			.request("session.setThinkingLevel", { sessionId: store.sessionId, thinkingLevel: level ?? null })
			.then(() => {
				// Refresh auto flag + level immediately: thinkingInfoAuto is
				// the chip's authority, and without this it would keep showing
				// "auto" after the user pins a concrete level (the 3s poll is
				// too slow for a click → chip latency the user can see).
				fetchThinkingInfo();
			})
			.catch(() => {});
	};
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
		): void => {
			setJumpBack(null);
			// Sending from a branch point commits it: drop the explicit leaf so
			// the view follows the new tip. Without this the transcript filter
			// (visibleEntries, anchored on the leaf) would hide the very answer
			// the send just produced.
			setCurrentLeafKey(null);
			setPinnedPathIds(null);
			onSend(text, images, deliverAs);
		},
		[onSend],
	);
	// 保存为图片 → the export dialog (options + live preview) owns the
	// rasterization; the transcript row's save button just opens it.
	const [saveImageText, setSaveImageText] = useState<string | null>(null);

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
				window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("branch failed") }));
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
			if (text) setPendingEdit(text);
			setJumpBack(fromLeafKey ? { fromLeafKey, text } : null);
			pulseSwitch();
			return true;
		} catch (err) {
			const reason = `${t("branch failed")}: ${err instanceof Error ? err.message : String(err)}`;
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
	// Retry (重新生成该回复): branch to the user message that produced
	// this reply and re-send it (TUI navigateTree parity, 2026-08-24).
	// session.branchAt moves the session leaf IN PLACE — the old reply and
	// any later tail stay on the tree as a sibling branch (NOT truncated
	// like revertTo, NOT copied like forkAt). The new turn re-answers the
	// user message and forks a parallel branch.
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
		return confirm(`${t("agent is running")}\n\n${t("tree op interrupts work")}`, t("interrupt and continue"));
	}, [confirm, snap?.working, t]);
	// 统一树操作守卫(retry / rewind / switchBranch / fork 共用):运行中先
	// 确认,确认后停下在途回合并等它真正收敛(branchAt 在在途回合下重锚
	// 会把回复挂错节点,2026-09-16 用户报告)。纯导航(jump)不走此守卫。
	// 返回 false = 用户取消了确认(操作未执行)。
	const runTreeOp = useCallback(
		async (op: () => unknown): Promise<boolean> => {
			if (!(await confirmTreeOpWhileWorking())) return false;
			if (snapRef.current?.working) onStop();
			await waitWorkingCleared();
			await op();
			return true;
		},
		[confirmTreeOpWhileWorking, onStop, waitWorkingCleared],
	);
	const retryFromUserMessage = async (messageId: string, text: string): Promise<void> => {
		// Converged path: branchAt AFTER the run actually unwinds, otherwise the
		// re-anchor races the in-flight run and the reply lands under the wrong
		// node (user report 2026-09-16).
		await runTreeOp(async () => {
			const res = await branchTo(messageId);
			// session.branchAt positions a USER message at its PARENT (the node is
			// re-answered by the send that follows), so the pinned leaf sits at the
			// branch point — and the transcript, which renders the active path,
			// would hide the very attempt we are about to create (the user saw only
			// the "此节点有 N 个分支" divider while the map showed the new branch).
			// Release the pin so the view follows the new tip, exactly like the
			// composer's own send path.
			setCurrentLeafKey(null);
			setPinnedPathIds(null);
			if (res?.editorText) onSend(res.editorText);
			else if (res) onSend(text);
		});
	};
	// Rewind (撤回, the ⤺ action under a USER message): branch to the user
	// message's PARENT — the node BEFORE it — so the user message itself also
	// drops out of the active path (user-reported semantics, 2026-09-15).
	// Distinct from onEdit, which keeps the node and backfills its text, and
	// from retry, which keeps the node and re-answers it. The dropped tail
	// stays on the tree (map/trajectory) as a sibling branch; nothing is
	// truncated.
	const rewindFromUserMessage = async (messageId: string): Promise<void> => {
		// Converged path: branchAt AFTER the run actually unwinds (runTreeOp).
		// Hand the message's own id to branchAt: the daemon's user→parent
		// mapping covers rewind-to-root natively. The old entry lookup +
		// null-parentId interception toasted "branch failed" BEFORE the RPC
		// whenever the first user message was rewound.
		await runTreeOp(() => jumpBackToMessage(messageId, ""));
	};
	// Pending composer prefill: message text sent back for re-editing
	// (jump-back 回填 + transcript inline edit). null = no pending edit.
	const [pendingEdit, setPendingEdit] = useState<string | null>(null);
	// Fork (分叉 / TUI /branch parity): non-destructive — copy the session
	// truncated at this message into a NEW session, open it, and backfill
	// the composer with the message text (the TUI /branch loads the
	// selected message into the editor so the user can re-answer it).
	// `includeTarget` keeps the node as the new session's last record (TUI
	// navigateTree parity for assistant/toolResult nodes — continue from
	// there with a fresh prompt); user messages truncate before the node
	// and re-answer via the backfilled text.
	const forkFromMessage = async (messageId: string, text?: string, includeTarget?: boolean): Promise<void> => {
		if (!store) return;
		// Tree-op guard (runTreeOp): forking while a run is in flight copies a
		// mid-flight snapshot — confirm + stop + wait like the other tree ops.
		await runTreeOp(async () => {
			try {
				const res = await rpc.request<{ sessionId: string; parentId: string }>("session.forkAt", {
					sessionId: store.sessionId,
					messageId,
					includeTarget,
				});
				if (res?.sessionId) {
					await onForkSession?.(res.sessionId);
					if (text) setPendingEdit(text);
				}
			} catch {
				// daemon rejected (unknown message/session) — keep as-is
			}
		});
	};
	// ── Layer-1 session-tree topology (nav unification, 2026-08-24) ────
	// Children index over the view entries by parentId; the active path
	// (breadcrumb + transcript filtering) walks from the leaf up.
	const branchChildren = useMemo(() => {
		const map = new Map<string, { id: string; kind: string }[]>();
		for (const entry of snap?.entries ?? []) {
			const e = entry as { id?: string; parentId?: string | null; type?: string; message?: { role?: string } };
			if (typeof e.id !== "string" || typeof e.parentId !== "string" || !e.parentId) continue;
			const bucket = map.get(e.parentId);
			const row = {
				id: e.id,
				kind: e.type === "message" ? (e.message?.role ?? "message") : (e.type ?? "entry"),
			};
			if (bucket) bucket.push(row);
			else map.set(e.parentId, [row]);
		}
		return map;
	}, [snap?.entries]);
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
	}, [currentLeafKey, snap?.entries]);
	// Walk root → leaf via parentId (breadcrumb path). `complete` records WHY the
	// walk stopped: at a genuine root (an entry with no parentId — the topology
	// is trustworthy) or on a parentId that is not in the loaded window (the
	// chain is cut). The daemon rewrites SDK hex ids to message keys and clears
	// a link it cannot resolve, so a history session opened fresh can hand us a
	// chain whose start is outside the window — and filtering the transcript
	// against such a partial path dropped nearly every row (user: 打开旧会话只
	// 显示到最开始那条, 会话树也没亮).
	const leafWalk = useMemo(() => {
		// Pinned to the session root: no leaf, so the active path is empty
		// (and trustworthy — nothing is cut).
		if (currentLeafKey === "root") return { path: [] as { id: string; kind: string }[], complete: true };
		const byId = new Map<string, { id: string; kind: string }>();
		const byKey = new Map<string, { id?: unknown; parentId?: unknown; type?: string }>();
		for (const entry of snap?.entries ?? []) {
			const e = entry as { id?: string; type?: string; message?: { role?: string } };
			if (typeof e.id !== "string") continue;
			byId.set(e.id, {
				id: e.id,
				kind: e.type === "message" ? (e.message?.role ?? "message") : (e.type ?? "entry"),
			});
			byKey.set(e.id, e);
		}
		const path: { id: string; kind: string }[] = [];
		const seen = new Set<string>();
		let cursor = effectiveLeaf;
		let complete = false;
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			const node = byId.get(cursor);
			if (!node) break; // parentId outside the window → chain cut
			path.unshift(node);
			const entry = byKey.get(cursor);
			const parent = entry?.parentId;
			if (typeof parent !== "string") {
				complete = true; // reached a root
				break;
			}
			if (!byKey.has(parent)) break; // next hop is missing → chain cut
			cursor = parent;
		}
		return { path, complete };
	}, [effectiveLeaf, currentLeafKey, snap?.entries]);
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
	}, [snap?.entries, leafPath]);
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
	const visibleEntries = useMemo(() => {
		// The gate is the leaf pin, not "is branched": a rewind to a historical
		// node drops the tail even in an otherwise-linear session. An
		// untrustworthy topology (see leafWalk) must never hide rows — UNLESS
		// the daemon shipped the active path for THIS move (pinnedPathIds):
		// that set survives the tail window, so filtering by it is exact even
		// when the local parentId chain is cut.
		if (!leafWalk.complete) {
			if (!pinnedPathIds) return snap?.entries ?? [];
			return (snap?.entries ?? []).filter(entry => {
				const e = entry as { id?: unknown; parentId?: unknown; type?: string };
				if (typeof e.id !== "string") return true;
				if (typeof e.parentId !== "string") {
					// Root-hung rows (round markers, synthetic rows) stay; a
					// root MESSAGE only shows when it is on the pinned path
					// (the full session's root lives above a cut window, so
					// this only matters for truncated daemon paths).
					return e.type !== "message" || pinnedPathIds.has(e.id);
				}
				return pinnedPathIds.has(e.id);
			});
		}
		const pinnedToRoot = currentLeafKey === "root";
		return (snap?.entries ?? []).filter(entry => {
			const e = entry as { id?: unknown; parentId?: unknown; type?: string };
			if (typeof e.id !== "string") return true;
			if (typeof e.parentId !== "string") {
				// Root-hung rows (round markers, synthetic rows) always stay —
				// except the first USER message when pinned to the root: it is
				// the node we rewound past and must leave the transcript.
				if (pinnedToRoot && e.type === "message") return false;
				return true;
			}
			return activePathIds.has(e.id);
		});
	}, [snap?.entries, activePathIds, leafWalk.complete, currentLeafKey, pinnedPathIds]);
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
				label: labelOf(p, i === 0 ? t("root") : "…"),
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
				const entry = (snapRef.current?.entries ?? []).find(
					e => typeof e === "object" && e !== null && (e as { id?: unknown }).id === target,
				);
				const ts =
					typeof entry === "object" && entry !== null ? (entry as { timestamp?: unknown }).timestamp : null;
				if (typeof ts === "string") requestJump(ts);
				setCurrentLeafKey(target);
				await branchTo(target, target);
			});
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[runTreeOp, branchTipOf, branchTo],
	);
	// switchToNode: 统一树节点切换入口(画布双击/MessageTree 行点击/面包屑)。
	// 对齐 TUI /tree 的 navigateTree 语义——移动到目标 leaf + 滚动 + 回填草稿。
	const switchToNode = useCallback(
		async (id: string): Promise<void> => {
			// Tree-op guard (runTreeOp): moving the leaf under an in-flight run
			// re-anchors it — confirm + stop + wait like retry/rewind/fork.
			await runTreeOp(async () => {
				const entry = (snap?.entries ?? []).find(
					e => typeof e === "object" && e !== null && (e as { id?: unknown }).id === id,
				);
				const ts =
					typeof entry === "object" && entry !== null ? (entry as { timestamp?: unknown }).timestamp : null;
				if (typeof ts === "string") requestJump(ts);
				// #12: an explicit node switch supersedes the revert dock — its undo
				// target is the leaf we CAME FROM, which this jump just replaced.
				setJumpBack(null);
				// Pin the clicked node itself: branchAt answers a USER message by
				// positioning at its parent, and following that leaf hid the node
				// the user just navigated to.
				const res = await branchTo(id, id);
				if (res?.editorText) setPendingEdit(res.editorText);
			});
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[snap?.entries, runTreeOp, branchTo],
	);

	// Lazy history backfill (kimi/DSH parity): the transcript fires this
	// when its tail window is fully expanded and the user scrolls up past
	// the oldest loaded entry. Pages the next chunk from session.history
	// (cursor = oldest loaded entry id) and prepends it into the store —
	// the daemon keeps the full transcript, nothing is lost.
	const loadOlderRef = useRef(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	// Key-based prepend anchoring (Transcript.anchorCtlRef): captured before
	// the session.history RPC, restored after the prepend commits — the old
	// scrollHeight-delta compensation jumped blindly (streaming tail growth
	// and estimate corrections both skew the delta) and triggered
	// measurement-correction cascades.
	const anchorCtlRef = useRef<TranscriptAnchorCtl | null>(null);
	const loadOlder = useCallback(async (): Promise<void> => {
		if (!rpc || !store || loadOlderRef.current || !store.hasMore) return;
		const beforeId = store.historyBeforeId;
		if (!beforeId) return;
		loadOlderRef.current = true;
		setLoadingOlder(true);
		const anchor: TranscriptAnchor | null = anchorCtlRef.current?.capture() ?? null;
		try {
			const res = await rpc.request<{
				entries: SessionEntry[];
				hasMore: boolean;
				remaining: number;
			}>("session.history", {
				sessionId: store.sessionId,
				beforeId,
				maxMessages: 500,
			});
			if (res?.entries?.length) {
				store.prependEntries(res.entries, res.remaining);
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						if (anchor) anchorCtlRef.current?.restore(anchor);
					});
				});
			}
		} catch {
			// daemon rejected (unknown session) — keep as-is
		} finally {
			loadOlderRef.current = false;
			setLoadingOlder(false);
		}
	}, [rpc, store]);
	// Stable identity for the Transcript observer (rebuilding the observer
	// on every render would thrash the IntersectionObserver).
	const onLoadOlderStable = useCallback((): void => {
		void loadOlder();
	}, [loadOlder]);
	// Full-history backfill for the overview surfaces (轮级地图 / 消息级画布 /
	// 轨迹统计): the daemon tails only 200 entries and pages older chunks on
	// scroll, so snap.entries covers just the loaded window — the turn map
	// silently collapsed a 164-turn session to ~4 turns (verified live on
	// 01a06854, 9988 entries). These surfaces visualize the WHOLE session, so
	// on first open we loop session.history (cursor = oldest accumulated id,
	// 1000/call, loopback) into a LOCAL array — deliberately NOT via
	// store.prependEntries, which would disturb the transcript's render
	// window and fold state. Jumps still work: requestJump pages the target
	// region in through the normal transcript path.
	const [fullEntries, setFullEntries] = useState<SessionEntry[] | null>(null);
	const [fullLoading, setFullLoading] = useState(false);
	const fullSessionKeyRef = useRef<string | null>(null);
	const fullLoadingRef = useRef(false);
	const fullTokenRef = useRef(0);
	const ensureFullHistory = useCallback(async (): Promise<void> => {
		if (!rpc || !store || !store.sessionId) return;
		if (fullSessionKeyRef.current === store.sessionId) return;
		if (fullLoadingRef.current) return;
		const token = ++fullTokenRef.current;
		fullLoadingRef.current = true;
		fullSessionKeyRef.current = store.sessionId;
		setFullLoading(true);
		try {
			let acc: SessionEntry[] = [...((snap?.entries ?? []) as SessionEntry[])];
			let beforeId: string | undefined = acc[0]?.id;
			// 60 × 1000 = 60k entries cap: far beyond any realistic session;
			// beyond that the overview falls back to the loaded window.
			for (let guard = 0; guard < 60; guard++) {
				const res: HistoryPage = await rpc.request<HistoryPage>("session.history", {
					sessionId: store.sessionId,
					beforeId,
					maxMessages: 1000,
				});
				if (token !== fullTokenRef.current) return;
				if (!res?.entries?.length) break;
				acc = [...res.entries, ...acc];
				const olderId: string | undefined = res.entries[0]?.id;
				if (olderId !== undefined) beforeId = olderId;
				if (!res.hasMore || res.remaining <= 0) break;
			}
			if (token === fullTokenRef.current) setFullEntries(acc);
		} catch {
			// daemon rejected / transport hiccup — keep the loaded window
			if (token === fullTokenRef.current) setFullEntries(null);
		} finally {
			if (token === fullTokenRef.current) setFullLoading(false);
			fullLoadingRef.current = false;
		}
	}, [rpc, store, snap?.entries]);
	// Session switch: drop the previous session's full copy before the new
	// overview can accidentally read stale turns.
	useEffect(() => {
		fullTokenRef.current++;
		fullLoadingRef.current = false;
		fullSessionKeyRef.current = null;
		setFullEntries(null);
		setFullLoading(false);
	}, [store?.sessionId]);
	// Canvas (turn/message map) entry: backfill full history in the
	// background; the map renders the loaded window immediately and swaps to
	// the full set when the loop lands.
	useEffect(() => {
		if (viewMode === "canvas") void ensureFullHistory();
	}, [viewMode, ensureFullHistory]);
	// Entries fed to the overview surfaces: the full copy when available,
	// LIVE-MERGED with the tail window — not a frozen either/or. The old
	// `fullEntries ?? snap.entries` froze the map at first-open: the full
	// history grab could run mid-turn and permanently bake the optimistic
	// echo ghost (`user:optimistic-*`) plus every later round into the map
	// never appearing (verified live: map stuck at "1 轮" after a 3rd turn
	// sent from inside the map view). Merge = full copy minus ghosts as the
	// base, plus any tail rows the base has never seen (id-absent AND at/after
	// the base's oldest timestamp). Identity: cached on (fullEntries, live id
	// signature) so streaming frame replacement (new object, same id) does
	// NOT rebuild the array every frame — buildTrajectoryTree is O(n) and the
	// map would refit/recompute per frame otherwise.
	const overviewMergeRef = useRef<{
		full: SessionEntry[];
		liveSig: string;
		result: SessionEntry[];
	} | null>(null);
	const overviewEntries = useMemo(() => {
		const live = (snap?.entries ?? []) as SessionEntry[];
		if (!fullEntries) {
			overviewMergeRef.current = null;
			return live;
		}
		const liveSig = live.map(e => e.id).join(" ");
		const cache = overviewMergeRef.current;
		if (cache && cache.full === fullEntries && cache.liveSig === liveSig) return cache.result;
		const base = fullEntries.filter(e => typeof e.id !== "string" || !e.id.startsWith("user:optimistic-"));
		const seen = new Set(base.map(e => e.id));
		const cutoff = base[0]?.timestamp ?? "";
		const extra = live.filter(
			e =>
				!seen.has(e.id) &&
				(typeof e.id !== "string" || !e.id.startsWith("user:optimistic-")) &&
				(cutoff === "" || e.timestamp >= cutoff),
		);
		const result = extra.length > 0 ? [...base, ...extra] : base;
		overviewMergeRef.current = { full: fullEntries, liveSig, result };
		return result;
	}, [fullEntries, snap?.entries]);
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
		rpc.request<{ turns: TurnIndexItem[] }>("session.turns", { sessionId: store.sessionId })
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
		const lastTs = daemonTurns.length > 0 ? daemonTurns[daemonTurns.length - 1].timestamp : null;
		const extra = lastTs === null ? loadedTurns : loadedTurns.filter(t => t.timestamp > lastTs);
		return extra.length > 0 ? [...daemonTurns, ...extra] : daemonTurns;
	}, [daemonTurns, loadedTurns]);
	// TurnRail jump dispatcher (defined here — after loadOlder, which a jump
	// into the folded window pages through). The rail indexes the FULL session,
	// so the target may sit above the loaded window: page older chunks until
	// the entry materializes, then dispatch. (Dispatching immediately would
	// drop the jump — the Transcript resolves rows against the loaded set and
	// ignores requests it cannot find.)
	const requestJump = useCallback(
		(timestamp: string): void => {
			void (async () => {
				let guard = 0;
				while (
					rpc &&
					store &&
					snapRef.current?.entries.some(e => e.timestamp === timestamp) !== true &&
					store.hasMore &&
					guard < 200
				) {
					guard++;
					await loadOlder();
				}
				jumpNonceRef.current += 1;
				setJumpRequest({ timestamp, nonce: jumpNonceRef.current });
			})();
		},
		[rpc, store, loadOlder],
	);
	const turnsData = useMemo(
		() => ({
			turns: railTurns,
			hasMoreAbove: store?.hasMore === true,
			onRequestOlder: onLoadOlderStable,
		}),
		[railTurns, store?.hasMore, onLoadOlderStable],
	);
	// Per-model thinking ceiling + exact ladder (TUI /model parity): higher
	// ladder rungs are disabled in the composer's ThinkingSelector, and the
	// ladder itself is the current model's supported efforts. GuiHeader runs
	// the same query for its title label; this one feeds the selector.
	const [thinkingInfoLevel, setThinkingInfoLevel] = useState<string | null>(null);
	const [thinkingInfoResolved, setThinkingInfoResolved] = useState<string | null>(null);
	const [thinkingInfoAuto, setThinkingInfoAuto] = useState(false);
	const [thinkingCeiling, setThinkingCeiling] = useState<string | null>(null);
	const [thinkingEfforts, setThinkingEfforts] = useState<string[] | null>(null);
	// TUI status-line parity: auto shows the CONCRETE resolved effort once
	// the daemon classifies the turn ("◉ high"), "auto" while pending. The
	// configured selector state (auto vs pinned) is passed separately as
	// configValue so the menu can still highlight "auto" while the chip
	// shows the resolved level. Non-auto falls through to the wire entry /
	// session.thinkingInfo level.
	const thinkingLevel: string | null = (() => {
		if (!snap) return null;
		if (thinkingInfoAuto) return thinkingInfoResolved ?? "auto";
		let level: string | null = snap.state?.thinkingLevel ?? null;
		for (const entry of snap.entries) {
			if (entry.type === "thinking_level_change") level = entry.thinkingLevel ?? null;
		}
		return level ?? thinkingInfoLevel ?? null;
	})();
	// The work-timer badge wants the ACTUAL effort this round used — the
	// last thinking_level_change entry carries the auto-classified resolved
	// level (the composer chip above intentionally shows "auto", the
	// configured state; the badge must not).
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
	// Docked subagent detail (kimiwork parity: a swarm-card member row, the
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
		// Inline widgets hand results back to the conversation (kimi
		// sendPrompt parity) — same path as the composer.
		sendPrompt: (text: string) => sendAndCloseJump(text),
		// Tool cards with a "fix this in settings" action (web search
		// provider failures) jump straight to the matching section.
		openSettings: onOpenSettings ? (section?: string) => onOpenSettings(section) : undefined,
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
						new CustomEvent("musepi-gui-toast", { detail: `${t("widget download image")}: ${detail}` }),
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
						new CustomEvent("musepi-gui-toast", { detail: `${t("copy as image")}: ${detail}` }),
					);
				}
			})();
		},
	};
	const fetchThinkingInfo = useCallback((): void => {
		if (!rpc || !store) return;
		void rpc
			.request<{
				ceiling?: string | null;
				efforts?: string[];
				level?: string | null;
				auto?: boolean;
				resolved?: string | null;
			}>("session.thinkingInfo", { sessionId: store.sessionId })
			.then(info => {
				setThinkingCeiling(info?.ceiling ?? null);
				setThinkingEfforts(info?.efforts?.length ? info.efforts : []);
				setThinkingInfoLevel(info?.level ?? null);
				setThinkingInfoResolved(info?.resolved ?? null);
				setThinkingInfoAuto(info?.auto === true);
			})
			.catch(() => {});
	}, [rpc, store]);
	useEffect(() => {
		if (!store) return;
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{
					ceiling?: string | null;
					efforts?: string[];
					level?: string | null;
					auto?: boolean;
					resolved?: string | null;
				}>("session.thinkingInfo", { sessionId: store.sessionId })
				.then(info => {
					if (cancelled) return;
					setThinkingCeiling(info?.ceiling ?? null);
					setThinkingEfforts(info?.efforts?.length ? info.efforts : []);
					setThinkingInfoLevel(info?.level ?? null);
					setThinkingInfoResolved(info?.resolved ?? null);
					setThinkingInfoAuto(info?.auto === true);
				})
				.catch(() => {});
		};
		load();
		return () => {
			cancelled = true;
		};
	}, [rpc, store]);
	// The composer switches models itself (session.setModel) and the daemon
	// pushes a model_changed wire event — that re-renders the view but the
	// store reference stays stable, so the effect above never re-runs and the
	// selector would keep the OLD model's effort ladder. Refetch explicitly on
	// model change (ModelSection does the same via its own refreshThinking).
	const onComposerModelChange = useCallback((): void => {
		fetchThinkingInfo();
	}, [fetchThinkingInfo]);

	// Terminate confirmation (openchamber parity): the stop button asks
	// before aborting — the dialog explains what abort means (same
	// semantics as TUI Esc: current turn stops, queued messages stay).
	const handleStop = useCallback(async (): Promise<void> => {
		const ok = await confirm(
			`${t("terminate current turn?")}\n\n${t("the agent will stop current work; queued messages are kept and run on your next message (Esc in the TUI interrupts the same way)")}`,
			t("terminate"),
		);
		if (ok) onStop();
	}, [confirm, onStop]);
	// Session composer focus morph: same WAAPI height animation as the
	// welcome form — current → parent height (open) or content height
	// (closed); the inline height is set to the target immediately and the
	// running animation overrides it visually until it finishes.
	const composerWrapRef = useRef<HTMLDivElement | null>(null);
	const wrapMorphVer = useRef(0);
	useEffect(() => {
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
		el.style.height = `${from}px`;
		void el.offsetHeight;
		const anim = el.animate([{ height: `${from}px` }, { height: `${target}px` }], {
			duration: 280,
			easing: "cubic-bezier(0.22, 1, 0.36, 1)",
		});
		el.style.height = `${target}px`;
		// Release the pinned height once the morph settles (finish event is
		// unreliable — cancelled animations never fire it, headless never
		// advances — so a versioned timer backs it up). Open must stay
		// pinned (the fill); closed releases so autosize growth flows.
		const ver = ++wrapMorphVer.current;
		const release = (): void => {
			if (wrapMorphVer.current !== ver) return;
			if (!focusMode) el.style.height = "";
		};
		anim.addEventListener("finish", release);
		setTimeout(release, 320);
	}, [focusMode]);

	return (
		<main className="gui-pane-center relative flex min-h-0 min-w-0 flex-1 flex-col">
			{/* Selection→ask popover (session-scoped throwaway turns). */}
			<AskPopover rpc={rpc} sessionId={store?.sessionId ?? null} />
			{/* Window drag strip: the 8px margin above the floating surface
			 * plus the header's blank areas stay draggable (openchamber
			 * app-region-drag header); every button inside is no-drag. */}
			<div className="gui-drag-strip" aria-hidden />
			{/* Workspace split (ZCode 工作区面板改版 parity): the session column,
			 * the side pane and the terminal dock are INDEPENDENT rounded cards
			 * floating on the glass base (docs/archive/gui-right-panel-redesign.md
			 * §3.3.2 / zcode-absorption-todos #工作区面板拆分) — no more single
			 * card with a vertical divider. This wrapper is layout-only now;
			 * each region carries its own card chrome. `gui-chat-surface` stays
			 * as the JS anchor for the maximize measurement query. The window
			 * header (GuiHeader) is a separate container ABOVE it. */}
			<div
				className="gui-chat-surface flex min-h-0 flex-1 flex-col"
				style={{ margin: "var(--gui-card-gutter)", gap: "var(--gui-card-gutter)" }}
			>
				{/* Scene stack: both scenes mount during the 420ms overlap window,
				 * each absolute-filling this wrapper (so they cross-fade/morph
				 * full-surface). The wrapper itself is IN FLOW — the terminal
				 * dock after it genuinely pushes the scenes up instead of the
				 * dock becoming the only in-flow child and landing on top. */}
				{/* Optional informational status bar (settings → 外观 → 信息状态条). */}
				<SessionStatusBar rpc={rpc} sessionId={store?.sessionId ?? ""} state={snap?.state ?? null} />
				<div className="gui-scenes relative min-h-0 flex-1">
					{showWelcome && (
						<div
							ref={welcomeSceneRef}
							className={`gui-scene gui-scene-welcome relative min-h-0 flex-1${welcomeLeaving ? " gui-scene--leaving" : ""}`}
						>
							{/* Same rounded floating card as the chat scene and the
							 * settings main view: the welcome scene used to sit
							 * directly on the glass, so it read as "not a rounded
							 * container" (user report 2026-09-16). */}
							<div
								className="gui-float-card gui-welcome-card flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]"
								style={{ margin: "var(--gui-card-gutter)" }}
							>
								<WelcomeComposer
									busy={busy}
									rpc={rpc}
									project={project}
									onProject={onProject}
									focused={focusMode}
									onToggleFocus={onToggleFocus}
									presetModelId={defaultModelId}
									presetThinkingLevel={presetThinkingLevel}
									onSubmit={(text, opts) => onSubmitNewSession(text, opts)}
									reminders={reminders}
									onSelectReminder={onSelectReminder}
									onMarkAllRead={onMarkAllRead}
									modes={modes}
									modeId={modeId}
									onModeChange={onModeChange}
									onAddProvider={onAddProvider}
								/>
							</div>
						</div>
					)}
					{showChat && store && (
						<div
							ref={chatSceneRef}
							className={`gui-scene gui-scene-chat flex min-h-0 flex-1 flex-col${chatLeaving ? " gui-scene--leaving" : ""}${showWelcome ? " gui-scene-chat--direct" : ""}`}
						>
							<div className="flex min-h-0 flex-1">
								{/* Session column: transcript + composer + dock — the
								 * right panel sits BESIDE this column (same level), so
								 * opening it pushes the composer left (openchamber
								 * MainLayout main | ContextPanel). */}
								<div className="gui-chat-column gui-float-card flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-surface)]">
									{/* Maximize anchor (docs §3.3.2): the floated panel and
									 * its backdrop measure THIS column — the old target
									 * (.gui-chat-surface) also contains the panel and the
									 * rail, so maximizing swallowed the rail. */}
									{/* Focus mode hides the whole transcript column (not just the
									 * scroll container): the wrapper also carries flex:1, so
									 * leaving it mounted would split the surface in half and
									 * the composer could never fill it. */}
									<div className={focusMode ? "hidden" : "relative flex min-h-0 min-w-0 flex-1 flex-col"}>
										{paused === true && (
											<div className="gui-pause-banner" role="status" aria-live="polite">
												<span className="gui-pause-banner-icon">
													<Icon name="pause" className="h-3.5 w-3.5" />
												</span>
												<span className="gui-pause-banner-text">
													{t("paused")}
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
														{t("resume")}
													</button>
												)}
											</div>
										)}
										{/* Scroll-shadow (openchamber ScrollShadow parity): a real
										 * content fade via mask-image, applied only while the
										 * transcript overflows (top/bottom data attrs). */}
										<div className="gui-transcript-wrap relative min-h-0 min-w-0 flex-1">
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
													{t("surface chat")}
												</button>
												<button
													type="button"
													role="tab"
													aria-selected={viewMode === "canvas"}
													className={`gui-surface-mode-btn${viewMode === "canvas" ? " gui-surface-mode-btn--on" : ""}`}
													onClick={() => setViewMode("canvas")}
												>
													<Icon name="apps-2-ai" className="h-3 w-3" />
													{t("surface canvas")}
												</button>
											</div>
											{/* Floating status cards (ZCode 悬浮卡 parity): live git
											 * state + subagents + todo progress, pinned top-right;
											 * hidden entirely when there is nothing to show. */}
											<StatusCards
												rpc={rpc}
												cwd={store?.cwd ?? ""}
												progress={snap?.progress ?? null}
												entries={snap?.entries ?? []}
												working={snap?.working ?? false}
												onOpenSurface={view => {
													setActiveView(view);
													if (!rightPanelOpen || focusMode) onExpandRightPanel?.();
												}}
											/>
											{/* History-session cold-open skeleton (React-Bits style):
											 * the daemon reactivates the session on demand — cover
											 * the (stale) previous transcript while the RPC runs. */}
											{sessionLoading === true && (
												<div
													className="gui-session-loading"
													role="status"
													aria-label={t("loading session")}
												>
													<div className="gui-loading-skeleton" aria-hidden>
														<span className="gui-loading-bar" />
														<span className="gui-loading-bar" style={{ width: "82%" }} />
														<span className="gui-loading-bar" style={{ width: "58%" }} />
													</div>
													<div className="gui-loading-note">
														<span className="gui-loading-orb" aria-hidden />
														{t("loading session")}
													</div>
												</div>
											)}
											{viewMode === "canvas" ? (
												<TurnMapCanvas
													entries={overviewEntries}
													loading={fullLoading && fullEntries === null}
													roundDurations={snap?.roundDurations}
													leafId={effectiveLeaf}
													activePathIds={trustedPathIds}
													onJumpToEntry={entryId => {
														// 双击/右键跳转:回对话模式 + 定位该轮(纯导航,
														// 不动 leaf)。
														const ts = overviewEntries.find(
															e =>
																typeof e === "object" &&
																e !== null &&
																(e as { id?: unknown }).id === entryId,
														);
														const t2 =
															typeof ts === "object" && ts !== null
																? (ts as { timestamp?: unknown }).timestamp
																: null;
														if (typeof t2 === "string") {
															setViewMode("chat");
															requestJump(t2);
														}
													}}
													onSwitchToBranch={id => {
														// 「切换到此分支」:显式移动 leaf(session.branchAt,
														// switchToNode 内含运行中保护 + 跳转 + 草稿回填)。
														void switchToNode(id);
													}}
													onBranchTo={id => {
														// 重答:分支到该轮并回填草稿(branchAt 定位在该轮
														// 本身,下一次发送即重答;运行中保护在 runTreeOp)。
														void runTreeOp(async () => {
															const res = await branchTo(id, id);
															if (res?.editorText) setPendingEdit(res.editorText);
														});
													}}
													onForkAt={id => {
														const entry = overviewEntries.find(
															e =>
																typeof e === "object" &&
																e !== null &&
																(e as { id?: unknown }).id === id,
														);
														const isUser = entry?.type === "message" && entry.message.role === "user";
														void forkFromMessage(id, undefined, !isUser);
													}}
												/>
											) : (
												<>
													<div
														ref={transcriptRef}
														className={`gui-transcript min-h-0 min-w-0 h-full overflow-y-auto px-5 py-4${sessionLoading === true ? "" : " gui-transcript--fadein"}`}
														data-top-scroll="false"
														data-bottom-scroll="false"
													>
														<CodeHighlightProvider highlight={chatHighlight}>
															<Transcript
																entries={visibleEntries}
																sessionKey={store?.sessionId ?? ""}
																/* Turn header model chip: same provider/id compound as
																 * DetailsPanel ("p/id"); render-units keeps the LAST
																 * model_change inside a turn, so a mid-turn switch still
																 * names the model that produced the reply. */
																model={
																	snap?.state?.model
																		? `${snap.state.model.provider}/${snap.state.model.id}`
																		: undefined
																}
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
																/* Chat settings (openchamber parity): user message
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
																/* TUI display-settings parity: the daemon
																 * settings drive the transcript (unflagged
																 * from tuiOnly 2026-08-12). */
																smoothStreaming={displaySettings["display.smoothStreaming"] !== false}
																hideToolActivity={displaySettings["display.hideToolActivity"] === true}
																showTokenUsage={displaySettings["display.showTokenUsage"] === true}
																collapseCompacted={
																	displaySettings["display.collapseCompacted"] === true
																}
																taskCardStyle={
																	displaySettings["display.taskCardStyle"] === "classic"
																		? "classic"
																		: "swarm"
																}
																colorBlind={displaySettings.colorBlindMode === true}
																onQuote={text => appendQuote(text)}
																/* 撤回: move the leaf only — nothing is
																 * backfilled into the composer (与「编辑并
																 * 重发」互补)。 */
																onRevert={id => void rewindFromUserMessage(id)}
																/* 编辑并重发 (TUI navigateTree 选用户消息 parity):
																 * branchAt 到该消息(leaf 落父节点,旧尾部成为
																 * sibling branch)+ 原文回填 composer——发送即在
																 * 该位置重答。 */
																onEdit={(id, text) => void jumpBackToMessage(id, text)}
																onFork={(id, text, includeTarget) =>
																	void forkFromMessage(id, text, includeTarget)
																}
																onLoadOlder={onLoadOlderStable}
																loadingOlder={loadingOlder}
																anchorCtlRef={anchorCtlRef}
																onRetry={(id, text) => void retryFromUserMessage(id, text)}
																onSpeak={(text, id) => {
																	// TTS read-aloud via the daemon's local Kokoro worker;
																	// 行级播放状态(朗读中 → 该行按钮高亮,点击停止)。
																	if (stopSpeakRef.current) {
																		stopSpeakRef.current();
																		setSpeakingId(null);
																		return;
																	}
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
																/* ZCode: avatars replace the 宿主/代理 gutter labels. */
																userGutter={showAvatars ? <UserAvatar rpc={rpc} cwd={store.cwd} /> : ""}
																agentGutter={showAvatars ? <AgentAvatar state={orb} size={64} /> : ""}
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
													</div>
													{/* Jump-to-bottom: the shared client-core Transcript owns the
													 * canonical .tr-back-bottom (M1.10, ZCode-parity follow re-arm).
													 * The old desktop-local JumpToBottomButton was a DUPLICATE of
													 * it (user: 滚动到底部的按钮有俩) and has been removed. */}
													{/* Message-tree navigation (TUI tree-selector parity):
													 * a floating searchable turn tree — jump to any
													 * position in the conversation, or fork a new session
													 * from any node (user nodes re-answer with the message
													 * text; assistant/toolResult nodes continue from the
													 * node). Anchored to the WRAP (not the outer column) so
													 * the pause banner — which lives in the column above
													 * the wrap — can never sit under it. */}
													<MessageTreeButton
														entries={snap?.entries ?? []}
														onJump={requestJump}
														onNavigateTo={entry =>
															// TUI tree-selector parity: 行点击切换 leaf(而非仅
															// 滚动),与画布双击同一入口。
															switchToNode(entry.id)
														}
														onFork={(entry, text, includeTarget) =>
															void forkFromMessage(entry.id, text, includeTarget)
														}
														onRevertTo={entry => void jumpBackToMessage(entry.id, "")}
														activePathIds={trustedPathIds}
													/>
													{/* In-message text selection actions (openchamber parity):
													 * quote a snippet (not the whole message), copy, start a
													 * new session from it, or append it to the workspace notes. */}
													<SelectionToolbar
														containerRef={transcriptRef}
														onQuote={text => appendQuote(text)}
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
															className={`gui-recap-row${recapExpanded ? " gui-recap-row--expanded" : ""}`}
															title={recapExpanded ? t("collapse") : t("expand")}
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
																title={t("dismiss")}
																aria-label={t("dismiss")}
																onClick={e => {
																	e.stopPropagation();
																	store?.dismissRecap();
																}}
															>
																<Icon name="close" className="h-3 w-3" />
															</button>
														</div>
													)}
												</>
											)}
										</div>
										{/* Turn-position rail (openchamber PromptNavigatorRail
										 * parity): a marker per user message — hover previews
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
											onJumpToTurn={ts => requestJump(ts)}
										/>
									</div>
									<div
										ref={composerWrapRef}
										className={
											focusMode
												? "gui-composer-wrap flex min-h-0 flex-col px-5 pb-3"
												: "gui-composer-wrap flex flex-shrink-0 flex-col px-5 pb-3"
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
											<div className="gui-revert-dock" role="region" aria-label={t("jumped back")}>
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
															? t("jumped back to") + (jumpBack.text ? `: ${jumpBack.text}` : "")
															: t("jumped back")}
													</span>
													<button
														type="button"
														className="gui-pane-action !w-auto px-1.5"
														title={t("undo jump")}
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
														title={t("close")}
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
														<p className="gui-revert-hint">{t("jump back hint")}</p>
													</div>
												</Reveal>
											</div>
										</Reveal>
										{snap?.approvals.map(a => (
											<ApprovalCard
												key={a.requestId}
												requestId={a.requestId}
												tool={a.tool}
												prompt={a.prompt}
												onDecide={onDecideApproval}
											/>
										))}
										{ask && onAskAnswer && (
											<div className="gui-ask-float">
												<AskCard ask={ask} onAnswer={answer => onAskAnswer(answer)} />
											</div>
										)}
										{/* Layer-1 session-tree nav chrome: breadcrumb path + fork hint
										 * above the composer (root > … > leaf, click any segment to jump). */}
										{currentLeafKey !== null && (
											<SessionTreeNav
												segments={breadcrumb}
												activeLeafIsHistorical={leafChildren.length > 0}
												activeLeafLabel={labelOf({ id: effectiveLeaf ?? "" }, t("this node"))}
												onJump={id => {
													// /tree parity: 点击路径段 = 切换 leaf 到该节点
													// (旧尾部保留为 sibling branch),非仅滚动。
													switchToNode(id);
												}}
											/>
										)}
										<Composer
											working={snap?.working ?? false}
											petMood={moodFromState({
												working: snap?.working ?? false,
												streaming: snap?.streaming ?? false,
												hasApprovals: (snap?.approvals.length ?? 0) > 0,
											})}
											petState={stateFromSignals({
												working: snap?.working ?? false,
												streaming: snap?.streaming ?? false,
												approvals: snap?.approvals.length ?? 0,
											})}
											onSend={sendAndCloseJump}
											onStop={() => void handleStop()}
											rpc={rpc}
											sessionId={store.sessionId}
											cwd={store.cwd}
											thinkingLevel={thinkingLevel}
											thinkingConfigLevel={thinkingInfoAuto ? "auto" : thinkingLevel}
											onSetThinking={setThinking}
											onModelChange={onComposerModelChange}
											onAddProvider={onAddProvider}
											thinkingCeiling={thinkingCeiling}
											thinkingEfforts={thinkingEfforts}
											presetModelId={presetModelId}
											welcome={showWelcome}
											quotes={quotes}
											onQuotesChange={setQuotes}
											pendingEdit={pendingEdit}
											onEditConsumed={() => setPendingEdit(null)}
											focused={focusMode}
											onToggleFocus={onToggleFocus}
											onBtw={q => setBtwQuestion(q)}
											activeTask={
												displaySettings["display.taskCardStyle"] === "classic"
													? null
													: ([...(snap?.activeTools?.values() ?? [])]
															.filter(t => t.toolName === "task")
															.at(-1) ?? null)
											}
											swarmHost={host}
										/>
									</div>
								</div>
								{/* Right panel stays mounted so the width collapse animates;
								 * `open` folds it to a 0px sliver instead of unmounting. */}
								<ContextPanel
									snap={snap}
									rpc={rpc}
									open={rightPanelOpen && !focusMode}
									openRequest={openFileReq}
									browserOpenRequest={openBrowserReq}
									onViewChange={setActiveView}
									panelTabs={panelTabs}
									onExpandPanel={onExpandRightPanel}
									agentId={panelAgentId}
									onAgentSelect={selectAgent}
									agentHost={host}
									extTabs={extTabs}
									overviewEntries={overviewEntries}
									overviewLoading={fullLoading && fullEntries === null}
									onEnsureFullHistory={() => void ensureFullHistory()}
									onJumpToEntry={entryId => {
										const ts = snap?.entries.find(e => e.id === entryId)?.timestamp;
										if (ts) requestJump(ts);
									}}
									leafId={effectiveLeaf}
									activePathIds={trustedPathIds}
									modeCatalog={modes}
									onBranchTo={id => {
										// Pin the clicked canvas node (see the trajectory
										// handler: branchAt maps user messages to parents).
										void branchTo(id, id).then(res => {
											if (res?.editorText) setPendingEdit(res.editorText);
										});
									}}
									onForkAt={id => {
										const entry = snap?.entries.find(e => e.id === id);
										const isUser = entry?.type === "message" && entry.message.role === "user";
										void forkFromMessage(id, undefined, !isUser);
									}}
								/>
								{/* Right-edge 44px icon rail (openchamber ContextPanelRail
								 * parity): tool icons + panel fold toggle + extension
								 * rail.right slot. Sibling of the panel at the surface's
								 * right edge. */}
								<RightRail
									sessionId={store?.sessionId ?? null}
									cwd={store?.cwd ?? ""}
									rpc={rpc}
									tool={activeView}
									rightPanelOpen={rightPanelOpen && !focusMode}
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
									onToggleRightPanel={onToggleRightPanel}
								/>
								{/* First browser-use hint: browser.gui defaults off, so the
								 * agent's first browsing turn is invisible — offer the
								 * managed in-app browser with a one-click switch. */}
								<BrowserGuiHint
									activeTools={snap?.activeTools}
									rpc={rpc}
									onView={() => setActiveView("browser")}
									onExpandPanel={onExpandRightPanel}
								/>
							</div>
						</div>
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
				{/* Terminal dock: stays MOUNTED so open/close animates (height
				 * 0 ↔ dockHeight) and running pty/xterm sessions survive the
				 * toggle — closing the last tab folds the dock instead. */}
				<div
					ref={terminalDockRef}
					className={`gui-terminal-dock relative flex flex-shrink-0 flex-col overflow-hidden border-t border-[var(--border)]${
						terminalOpen ? " gui-terminal-dock--open" : ""
					}`}
					style={{ height: terminalOpen ? dockHeight : 0 }}
				>
					{/* Drag handle: the dock pushes the composer up and its
					 * height is user-adjustable (openchamber bottom dock). */}
					<div className="gui-dock-handle" {...dockResizeDrag} style={{ touchAction: "none" }} aria-hidden />
					<TerminalPanel rpc={rpc} cwd={store?.cwd ?? project ?? ""} onAllClosed={onCloseTerminal} />
				</div>
			</div>
			{/* 保存为图片 export dialog (always mounted — DialogFrame drives its
			 * own enter/exit animation via `open`). */}
			<SaveImageDialog
				open={saveImageText !== null}
				text={saveImageText ?? ""}
				onClose={() => setSaveImageText(null)}
			/>
		</main>
	);
}
