import { CodeHighlightProvider, punkAvatarUri, relTime, Transcript, t } from "@musepi/desktop-web";
import type { SessionEntry } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type GitUser, readGitUser } from "../lib/git-user";
import { useChatHighlight } from "../lib/highlight";
import { moodFromState } from "../lib/pet";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionStore } from "../lib/session-store";
import { useExtensionToolViews } from "../lib/slot-host";
import { scrollToEntry } from "../lib/transcript-jump";
import { usePointerDrag } from "../lib/use-pointer-drag";
import { useStore } from "../lib/use-store";
import { speak } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import type { OrbState } from "../vendor/thinking-orbs";
import { AgentAvatar } from "./AgentAvatar";
import { ApprovalCard } from "./ApprovalCard";
import { type AskAnswer, AskCard, type AskRequest } from "./AskCard";
import { AskPopover } from "./AskPopover";
import { PunkAvatar } from "./avatar-presets";
import { Composer } from "./Composer";
import { ContextPanel } from "./ContextPanel";
import { JumpToBottomButton } from "./JumpToBottomButton";
import { MessageTreeButton } from "./MessageTree";
import type { ReminderRow } from "./RemindersPanel";
import { RightRail } from "./RightRail";
import { SaveImageDialog } from "./SaveImageDialog";
import { SelectionToolbar } from "./SelectionToolbar";
import { SubagentPanel } from "./SubagentPanel";
import { SessionStatusBar } from "./statusbar-info";
import { TerminalPanel } from "./TerminalPanel";
import type { ThinkingLevel } from "./ThinkingSelector";
import { TurnRail } from "./TurnRail";
import { WelcomeComposer } from "./WelcomeComposer";

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
	onToggleRightPanel,
	onExpandRightPanel,
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
	onDecideApproval(requestId: string, approved: boolean): void;
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
	/** Right-edge rail (RightRail) fold toggle — expands/collapses the
	 *  ContextPanel (app owns the persisted state). */
	onToggleRightPanel?(): void;
	/** Right-edge rail: expand the panel without toggling when a tool icon
	 *  is picked while the panel is collapsed. */
	onExpandRightPanel?(): void;
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
	// 注册进 desktop-web tool-render 外部表,transcript 按工具名分派。
	useExtensionToolViews(rpc);
	// Pause banner hold timer: tick every second while the freeze is engaged
	// so the "paused · mm:ss" clock advances.
	const [, setPauseTick] = useState(0);
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
			},
			activity => {
				if (activity.phase === "speaking") setSpeakingId(lastId);
				else if (activity.phase === "done" || activity.phase === "stopped" || activity.phase === "error") {
					stopSpeakRef.current = null;
					setSpeakingId(prev => (prev === lastId ? null : prev));
				}
			},
		);
		setSpeakingId(lastId);
	}, [snap, displaySettings["tts.autoRead"], displaySettings["tts.rate"], rpc]);
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
	// into entries at message_start — no separate ghost is kept).
	const orb: OrbState = snap?.working ? (snap.streaming ? "composing" : "working") : "listening";
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
		if (!el) return;
		el.dataset.switched = "1";
		el.scrollTop = el.scrollHeight;
		const timer = setTimeout(() => {
			delete el.dataset.switched;
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
	// Shared ContextPanel tool selection — controlled here so the right-edge
	// rail (RightRail) and the panel toggle the same view (modes v2 右面板).
	const [contextTool, setContextTool] = useState<string | null>(null);
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
	const [pendingEdit, setPendingEdit] = useState<string | null>(null);
	const setThinking = (level: ThinkingLevel | null): void => {
		if (!store) return;
		void rpc
			.request("session.setThinkingLevel", { sessionId: store.sessionId, thinkingLevel: level ?? null })
			.catch(() => {});
	};
	// Revert history (openchamber RevertedMessageDock parity): the daemon
	// is the single source of truth — session.revertList returns the
	// backed-up reverts (one entry per session.revertTo), so the dock can
	// never drift from what session.restoreRevert can actually restore.
	// The list renders as a collapsed dock card above the composer — NOT
	// inline in the transcript, so it never scrolls away with the messages.
	const [revertItems, setRevertItems] = useState<{ index: number; text: string; messageId: string }[]>([]);
	const [revertDockOpen, setRevertDockOpen] = useState(false);
	const prevRevertLen = useRef(revertItems.length);
	useEffect(() => {
		if (revertItems.length > prevRevertLen.current) setRevertDockOpen(false);
		prevRevertLen.current = revertItems.length;
	}, [revertItems.length]);
	const refreshReverts = useCallback(async (): Promise<void> => {
		if (!store) return;
		try {
			const res = await rpc.request<{ items: { index: number; text: string; messageId: string }[] }>(
				"session.revertList",
				{ sessionId: store.sessionId },
			);
			setRevertItems(res?.items ?? []);
		} catch {
			// old daemon without the RPC — keep the current list
		}
	}, [rpc, store]);
	useEffect(() => {
		void refreshReverts();
	}, [refreshReverts, store?.sessionId]);
	// Revert / edit-and-reconverse: truncate the session to before the user
	// message, reload the snapshot — the daemon records the backup, the
	// dock re-fetches it from session.revertList.
	// 保存为图片 → the export dialog (options + live preview) owns the
	// rasterization; the transcript row's save button just opens it.
	const [saveImageText, setSaveImageText] = useState<string | null>(null);

	const revertToMessage = async (messageId: string, _text: string, _edit: boolean): Promise<void> => {
		if (!store) return;
		try {
			await rpc.request("session.revertTo", { sessionId: store.sessionId, messageId });
			await onReloadSession?.();
			await refreshReverts();
		} catch {
			// daemon rejected — keep the transcript as-is
		}
	};
	// Retry (重新生成该回复): truncate to the user message that produced
	// this reply, then re-send it — the turn replays from the user node.
	// The old reply (and any later tail) lands in the revert backup, so
	// the 撤回 dock can restore it. NOT "send the assistant text back".
	// deliverAs is OMITTED on purpose: an explicit "followUp"/"steer" only
	// QUEUES the message without starting a turn when the session is idle
	// (AgentSession.sendUserMessage) — retry must start a fresh turn.
	const retryFromUserMessage = async (messageId: string, text: string): Promise<void> => {
		if (!store) return;
		try {
			await rpc.request("session.revertTo", { sessionId: store.sessionId, messageId });
			await onReloadSession?.();
			await refreshReverts();
			onSend(text);
		} catch {
			// daemon rejected — keep the transcript as-is
		}
	};
	// 回填: put the reverted text into the composer for re-editing.
	const restoreReverted = (text: string): void => {
		setPendingEdit(text);
	};
	// Undo ONE revert (还原单轮): the daemon re-inserts that backed-up
	// tail (agent context + journal + view), then we re-fetch the list and
	// reload the snapshot.
	const restoreItem = async (index: number): Promise<void> => {
		if (!store) return;
		try {
			const res = await rpc.request<{ ok: boolean }>("session.restoreRevert", {
				sessionId: store.sessionId,
				index,
			});
			if (res?.ok === true) {
				await refreshReverts();
				await onReloadSession?.();
			}
		} catch {
			// daemon rejected — keep the list as-is
		}
	};
	// Undo EVERY revert (还原全部): the daemon re-inserts every backed-up
	// tail (deduped), then we re-fetch the list and reload.
	const restoreAllReverts = async (): Promise<void> => {
		if (!store) return;
		try {
			const res = await rpc.request<{ ok: boolean }>("session.restoreRevert", {
				sessionId: store.sessionId,
				all: true,
			});
			if (res?.ok === true) {
				await refreshReverts();
				await onReloadSession?.();
			}
		} catch {
			// daemon rejected — keep the list as-is
		}
	};
	// 撤回 dock 的「重新发送」: re-send the reverted text as a NEW user
	// prompt. deliverAs is OMITTED on purpose — an explicit "followUp" only
	// queues the message without starting a turn when idle, so the button
	// would look dead. Omitting it starts a turn when idle (steers while
	// streaming), which is the actual "resend" semantic.
	const resendReverted = (text: string): void => {
		onSend(text);
	};
	const discardReverted = async (index: number): Promise<void> => {
		if (!store) return;
		try {
			await rpc.request("session.discardRevert", { sessionId: store.sessionId, index });
			await refreshReverts();
		} catch {
			// old daemon without the RPC — drop locally so the dock clears
			setRevertItems(prev => prev.filter(r => r.index !== index));
		}
	};
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
	};
	// Lazy history backfill (kimi/DSH parity): the transcript fires this
	// when its tail window is fully expanded and the user scrolls up past
	// the oldest loaded entry. Pages the next chunk from session.history
	// (cursor = oldest loaded entry id) and prepends it into the store —
	// the daemon keeps the full transcript, nothing is lost.
	const loadOlderRef = useRef(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const loadOlder = useCallback(async (): Promise<void> => {
		if (!rpc || !store || loadOlderRef.current || !store.hasMore) return;
		const beforeId = store.historyBeforeId;
		if (!beforeId) return;
		loadOlderRef.current = true;
		setLoadingOlder(true);
		// Anchor the scroll: prepending grows the top spacer, which would
		// shove the visible content down by the inserted height. Compensate
		// with the real scrollHeight delta after React commits (double rAF).
		const scroller = transcriptRef.current;
		const scrollTop = scroller?.scrollTop ?? 0;
		const scrollHeight = scroller?.scrollHeight ?? 0;
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
						if (scroller) scroller.scrollTop = scrollTop + (scroller.scrollHeight - scrollHeight);
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
	// Per-model thinking ceiling + exact ladder (TUI /model parity): higher
	// ladder rungs are disabled in the composer's ThinkingSelector, and the
	// ladder itself is the current model's supported efforts. GuiHeader runs
	// the same query for its title label; this one feeds the selector.
	const [thinkingInfoLevel, setThinkingInfoLevel] = useState<string | null>(null);
	const [thinkingInfoAuto, setThinkingInfoAuto] = useState(false);
	const [thinkingCeiling, setThinkingCeiling] = useState<string | null>(null);
	const [thinkingEfforts, setThinkingEfforts] = useState<string[] | null>(null);
	// Live thinking level: the daemon records thinking_level_change entries
	// but never mutates state.thinkingLevel, so derive the current level from
	// the LAST change entry — the composer chip updates the moment the entry
	// lands, without a transcript marker row. Auto mode reads as the user's
	// selector ("auto") from session.thinkingInfo — the realtime RPC is the
	// authoritative auto flag, since the wire entry carries only the
	// provisional/resolved effort, not the "auto" configuration.
	const thinkingLevel: string | null = (() => {
		if (!snap) return null;
		let level: string | null = snap.state?.thinkingLevel ?? null;
		for (const entry of snap.entries) {
			if (entry.type === "thinking_level_change") level = entry.thinkingLevel ?? null;
		}
		return thinkingInfoAuto ? "auto" : (level ?? thinkingInfoLevel ?? null);
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
	// Subagent trajectory panel (kimiwork parity): opening an agent from a
	// swarm-card member row or the right rail slides the panel out over the
	// chat column; the selected agent resolves against the live snapshot.
	const [panelAgentId, setPanelAgentId] = useState<string | null>(null);
	const panelAgent = panelAgentId !== null ? (snap?.agents.find(a => a.id === panelAgentId) ?? null) : null;
	const panelProgress = panelAgentId !== null ? (snap?.progress.get(panelAgentId)?.progress ?? null) : null;
	const host = {
		hasAgent: (id: string) => snap?.agents.some(a => a.id === id) === true,
		openAgent: (id: string) => {
			if (snap?.agents.some(a => a.id === id) === true) setPanelAgentId(id);
		},
		// Inline widgets hand results back to the conversation (kimi
		// sendPrompt parity) — same path as the composer.
		sendPrompt: (text: string) => onSend(text),
	};
	const fetchThinkingInfo = useCallback((): void => {
		if (!rpc || !store) return;
		void rpc
			.request<{ ceiling?: string | null; efforts?: string[]; level?: string | null; auto?: boolean }>(
				"session.thinkingInfo",
				{ sessionId: store.sessionId },
			)
			.then(info => {
				setThinkingCeiling(info?.ceiling ?? null);
				setThinkingEfforts(info?.efforts?.length ? info.efforts : []);
				setThinkingInfoLevel(info?.level ?? null);
				setThinkingInfoAuto(info?.auto === true);
			})
			.catch(() => {});
	}, [rpc, store]);
	useEffect(() => {
		if (!store) return;
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{ ceiling?: string | null; efforts?: string[]; level?: string | null; auto?: boolean }>(
					"session.thinkingInfo",
					{ sessionId: store.sessionId },
				)
				.then(info => {
					if (cancelled) return;
					setThinkingCeiling(info?.ceiling ?? null);
					setThinkingEfforts(info?.efforts?.length ? info.efforts : []);
					setThinkingInfoLevel(info?.level ?? null);
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
	const { confirm } = useConfirm();
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
			{/* The single rounded floating app surface — both scenes live in it.
			 * The window header (GuiHeader) is a separate container ABOVE it. */}
			<div className="gui-chat-surface m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
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
							/>
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
								<div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
											<div
												ref={transcriptRef}
												className={`gui-transcript min-h-0 min-w-0 h-full overflow-y-auto px-5 py-4${sessionLoading === true ? "" : " gui-transcript--fadein"}`}
												data-top-scroll="false"
												data-bottom-scroll="false"
											>
												<CodeHighlightProvider highlight={chatHighlight}>
													<Transcript
														entries={snap?.entries ?? []}
														/* No stream ghost: the view folds the assistant message into
														 * entries at message_start, so the entry row IS the live
														 * stream renderer (immutable upserts re-render it). */
														stream={null}
														streamDone={true}
														activeTools={snap?.activeTools ?? new Map()}
														working={snap?.working ?? false}
														roundDurations={snap?.roundDurations}
														thinkingLevel={resolvedThinkingLevel ?? undefined}
														host={host}
														/* Chat settings (openchamber parity): user message
														 * markdown/plain + long-message collapse. */
														userPlain={(() => {
															try {
																return localStorage.getItem("musepi-gui-chat-usermsg") === "plain";
															} catch {
																return false;
															}
														})()}
														collapseLongUserMessages={(() => {
															try {
																return localStorage.getItem("musepi-gui-chat-collapseuser") !== "0";
															} catch {
																return true;
															}
														})()}
														/* TUI display-settings parity: the daemon
														 * settings drive the transcript (unflagged
														 * from tuiOnly 2026-08-12). */
														smoothStreaming={displaySettings["display.smoothStreaming"] !== false}
														hideToolActivity={displaySettings["display.hideToolActivity"] === true}
														showTokenUsage={displaySettings["display.showTokenUsage"] === true}
														collapseCompacted={displaySettings["display.collapseCompacted"] !== false}
														taskCardStyle={
															displaySettings["display.taskCardStyle"] === "classic"
																? "classic"
																: "swarm"
														}
														colorBlind={displaySettings.colorBlindMode === true}
														onQuote={text => appendQuote(text)}
														onRevert={(id, text) => void revertToMessage(id, text, false)}
														/* 编辑并重发 (Transcript onEdit, previously unwired):
														 * backfill the composer with the message text for
														 * re-editing — same pendingEdit path as the revert
														 * dock's 恢复到输入框 and the fork flow. */
														onEdit={(_id, text) => setPendingEdit(text)}
														onFork={(id, text, includeTarget) =>
															void forkFromMessage(id, text, includeTarget)
														}
														onLoadOlder={onLoadOlderStable}
														loadingOlder={loadingOlder}
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
																		activity.phase === "stopped" ||
																		activity.phase === "error"
																	) {
																		stopSpeakRef.current = null;
																		setSpeakingId(prev => (prev === entryId ? null : prev));
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
													/>
												</CodeHighlightProvider>
											</div>
											{/* Jump-to-bottom (openchamber ScrollToBottomButton parity):
											 * floats over the composer edge while scrolled up. */}
											<JumpToBottomButton rootRef={transcriptRef} />
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
												transcriptRef={transcriptRef}
												onFork={(entry, text, includeTarget) =>
													void forkFromMessage(entry.id, text, includeTarget)
												}
												onRevertTo={entry => void revertToMessage(entry.id, "", false)}
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
													void rpc.request("notes.create", { cwd, body: `> ${text}` }).catch(() => {});
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
										</div>
										{/* Turn-position rail (openchamber PromptNavigatorRail
										 * parity): a marker per user message — hover previews
										 * the prompt, click jumps to that turn. */}
										<TurnRail rootRef={transcriptRef} entryCount={snap?.entries.length ?? 0} />
									</div>
									<div
										ref={composerWrapRef}
										className={
											focusMode
												? "gui-composer-wrap flex min-h-0 flex-col px-5 pb-3"
												: "gui-composer-wrap flex flex-shrink-0 flex-col px-5 pb-3"
										}
									>
										{/* Reverted-messages dock (openchamber RevertedMessageDock
										 * parity): a floating card above the input — collapsed
										 * to a header row by default, expand for 恢复/重发/分叉/丢弃.
										 * Lives OUTSIDE the transcript so it never scrolls away. */}
										{revertItems.length > 0 && (
											<div className="gui-revert-dock" role="region" aria-label={t("reverted messages")}>
												<div
													role="button"
													tabIndex={0}
													className="gui-revert-dock-head"
													onClick={() => setRevertDockOpen(v => !v)}
													onKeyDown={e => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															setRevertDockOpen(v => !v);
														}
													}}
													aria-expanded={revertDockOpen}
												>
													<Icon
														name="arrow-go-back"
														className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-warning)]"
													/>
													<span className="gui-revert-dock-title">
														{t("reverted messages ({count})", { count: String(revertItems.length) })}
													</span>
													<button
														type="button"
														className="gui-pane-action !w-auto px-1.5"
														title={t("restore all reverts")}
														onClick={e => {
															// The head is a click target for collapse/expand —
															// don't toggle it when the restore-all button fires.
															e.stopPropagation();
															void restoreAllReverts();
														}}
													>
														<Icon name="arrow-go-forward" className="h-3 w-3" />
													</button>
													<Icon
														name="arrow-down-s"
														className={`gui-revert-dock-chevron${revertDockOpen ? " gui-revert-dock-chevron--open" : ""}`}
														aria-hidden="true"
													/>
												</div>
												{revertDockOpen && (
													<div className="gui-revert-dock-body">
														{revertItems.map(r => (
															<div key={r.index} className="gui-revert-item">
																<span className="gui-revert-item-text" title={r.text}>
																	{r.text}
																</span>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("restore this revert")}
																	onClick={() => void restoreItem(r.index)}
																>
																	<Icon name="arrow-go-forward" className="h-3 w-3" />
																</button>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("restore into the input")}
																	onClick={() => restoreReverted(r.text)}
																>
																	<Icon name="arrow-go-back" className="h-3 w-3" />
																</button>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("resend")}
																	onClick={() => resendReverted(r.text)}
																>
																	<Icon name="send-plane" className="h-3 w-3" />
																</button>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("continue from this point in a new session")}
																	onClick={() => void forkFromMessage(r.messageId, r.text)}
																>
																	<Icon name="git-fork" className="h-3 w-3" />
																</button>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("discard")}
																	onClick={() => void discardReverted(r.index)}
																>
																	<Icon name="close" className="h-3 w-3" />
																</button>
															</div>
														))}
													</div>
												)}
											</div>
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
										{ask && onAskAnswer && <AskCard ask={ask} onAnswer={answer => onAskAnswer(answer)} />}
										<Composer
											working={snap?.working ?? false}
											petMood={moodFromState({
												working: snap?.working ?? false,
												streaming: snap?.streaming ?? false,
												hasApprovals: (snap?.approvals.length ?? 0) > 0,
											})}
											onSend={onSend}
											onStop={() => void handleStop()}
											rpc={rpc}
											sessionId={store.sessionId}
											cwd={store.cwd}
											thinkingLevel={thinkingLevel}
											onSetThinking={setThinking}
											onModelChange={onComposerModelChange}
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
									tool={contextTool}
									onToolChange={setContextTool}
									onJumpToEntry={entryId => {
										const ts = snap?.entries.find(e => e.id === entryId)?.timestamp;
										if (ts) scrollToEntry(transcriptRef.current, ts);
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
									tool={contextTool}
									rightPanelOpen={rightPanelOpen && !focusMode}
									onSelect={tool => {
										setContextTool(prev => (prev === tool ? null : tool));
										if (!rightPanelOpen) onExpandRightPanel?.();
									}}
									onToggleRightPanel={onToggleRightPanel}
								/>
							</div>
						</div>
					)}
				</div>
				{/* Subagent trajectory drawer (kimiwork parity): slides over the
				 * chat column when a swarm-card member row / right-rail agent
				 * is opened; the same ag-drawer chrome as the collab guest. */}
				{panelAgent !== null && !focusMode && (
					<SubagentPanel
						agent={panelAgent}
						rpc={rpc}
						progress={panelProgress}
						host={host}
						onClose={() => setPanelAgentId(null)}
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
