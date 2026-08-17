import { CodeHighlightProvider, relTime, Transcript, t } from "@musepi/collab-web";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type GitUser, readGitUser } from "../lib/git-user";
import { useChatHighlight } from "../lib/highlight";
import { moodFromState } from "../lib/pet";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionStore } from "../lib/session-store";
import { useStore } from "../lib/use-store";
import { speak } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import type { OrbState } from "../vendor/thinking-orbs";
import { AgentAvatar } from "./AgentAvatar";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ContextPanel } from "./ContextPanel";
import { JumpToBottomButton } from "./JumpToBottomButton";
import { SelectionToolbar } from "./SelectionToolbar";
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
 * `omp-gui-user-avatar`, `https://github.com/<login>.png`) with the git
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
			return localStorage.getItem("omp-gui-user-avatar") || null;
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
	}, [avatarUrl]);
	const initial = user?.name?.trim().charAt(0)?.toLocaleUpperCase() ?? "";
	const title = user ? (user.email ? `${user.name} <${user.email}>` : user.name) : t("you");
	return (
		<span className="gui-user-avatar" title={title}>
			{avatarUrl && !avatarFailed ? (
				<img src={avatarUrl} alt="" className="gui-user-avatar-img" onError={() => setAvatarFailed(true)} />
			) : initial ? (
				<span className="gui-user-avatar-letter">{initial}</span>
			) : (
				<Icon name="user" className="h-3.5 w-3.5" />
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
	busy,
	project,
	onProject,
	onSubmitNewSession,
	rightPanelOpen,
	onOpenFileInPanel,
	terminalOpen,
	focusMode,
	onToggleFocus,
	paused,
	pausedAt,
	onResume,
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
	/** Model chosen in the welcome composer before the session existed. */
	presetModelId?: string | null;
	/** Welcome scene (before the first session of the run). */
	busy: boolean;
	project: string | null;
	onProject(action: "folder" | "remote" | "none"): void;
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
	terminalOpen: boolean;
	/** Focus mode (openchamber ⌘⇧E): composer fills the surface. */
	focusMode: boolean;
	onToggleFocus(): void;
}): ReactNode {
	const noopSubscribe = (): (() => void) => () => {};
	const snap = useStore(
		store ? store.subscribe.bind(store) : noopSubscribe,
		store ? store.getSnapshot.bind(store) : () => null,
	);
	// Pause banner hold timer: tick every second while the freeze is engaged
	// so the "paused · mm:ss" clock advances.
	const [, setPauseTick] = useState(0);
	useEffect(() => {
		if (paused !== true) return;
		const timer = setInterval(() => setPauseTick(t => t + 1), 1_000);
		return () => clearInterval(timer);
	}, [paused]);
	// Recap relative timestamp: re-render once a minute while a recap is up.
	const [, setRecapTick] = useState(0);
	useEffect(() => {
		if (!snap?.recap) return;
		const timer = setInterval(() => setRecapTick(t => t + 1), 60_000);
		return () => clearInterval(timer);
	}, [snap?.recap]);
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
	// Avatar display toggle lives in Settings → appearance (omp-gui-avatars).
	const showAvatars = localStorage.getItem("omp-gui-avatars") !== "0";
	// Resizable terminal dock (drag the top edge).
	const [dockHeight, setDockHeight] = useState(176);
	const dockResize = (e: ReactPointerEvent): void => {
		const startY = e.clientY;
		const startH = dockHeight;
		const onMove = (ev: PointerEvent): void => {
			const h = Math.min(480, Math.max(96, startH + (startY - ev.clientY)));
			setDockHeight(h);
		};
		const onUp = (): void => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};
	const transcriptRef = useRef<HTMLDivElement | null>(null);
	// Session-switch reveal: when the active session changes, the transcript
	// rows play a staggered fade-in (逐字错峰) so the context swap reads as a
	// transition instead of a hard cut. The marker is removed after the
	// animation so streaming updates re-render normally.
	useEffect(() => {
		if (!store) return;
		const el = transcriptRef.current;
		if (!el) return;
		const sessionId = store.sessionId;
		el.dataset.switched = "1";
		const timer = setTimeout(() => {
			delete el.dataset.switched;
		}, 700);
		return () => clearTimeout(timer);
	}, [store?.sessionId]);
	// ZCode 引用回复: quoted text prepends the next composer message.
	const [pendingQuote, setPendingQuote] = useState<string | null>(null);
	// File-reveal requests from transcript paths / artifact cards: relayed
	// into the ContextPanel → FilePane preview. nonce re-triggers the same
	// path (re-click while already open).
	const [openFileReq, setOpenFileReq] = useState<{ path: string; nonce: number } | null>(null);
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
	// Revert history (user: revert should offer a restorable list — the old
	// pencil "edit and resend" merged into this; the pencil button is gone).
	const [revertHistory, setRevertHistory] = useState<{ id: string; messageId: string; text: string; at: number }[]>(
		[],
	);
	// Revert / edit-and-reconverse: truncate the session to before the user
	// message, reload the snapshot, then record the message in the revert
	// list (恢复 refills the composer, 重新发送 re-delivers as followUp).
	/** Render an assistant reply as a compact text card and copy it to the
	 *  clipboard as PNG (openchamber 保存为图片 parity). Plain canvas
	 *  drawing — no DOM snapshotting, so it works regardless of the
	 *  message's rendered markdown. Wrapped in try/catch: clipboard image
	 *  writes are async and can fail (permissions, unavailable API). */
	const saveMessageAsImage = async (text: string): Promise<void> => {
		try {
			const lines = text.split("\n");
			const maxWidth = 640;
			const lineHeight = 22;
			const pad = 24;
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			// Two passes: measure wrapped lines, then draw.
			ctx.font = "13px ui-monospace, SF Mono, Menlo, monospace";
			const wrapped: string[] = [];
			for (const line of lines) {
				if (line.length === 0) {
					wrapped.push("");
					continue;
				}
				let cur = "";
				for (const ch of line) {
					if (ctx.measureText(cur + ch).width > maxWidth - pad * 2) {
						wrapped.push(cur);
						cur = ch;
					} else {
						cur += ch;
					}
				}
				wrapped.push(cur);
			}
			const height = pad * 2 + wrapped.length * lineHeight + 14;
			canvas.width = maxWidth;
			canvas.height = height;
			const dark = matchMedia("(prefers-color-scheme: dark)").matches;
			ctx.fillStyle = dark ? "#16161a" : "#fdfdfd";
			ctx.fillRect(0, 0, maxWidth, height);
			ctx.fillStyle = dark ? "#e8e8e8" : "#232323";
			ctx.font = "13px ui-monospace, SF Mono, Menlo, monospace";
			wrapped.forEach((line, i) => {
				ctx.fillText(line, pad, pad + 18 + i * lineHeight);
			});
			const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
			if (!blob) return;
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
		} catch {
			// clipboard/image API unavailable — silent
		}
	};

	const revertToMessage = async (messageId: string, text: string, _edit: boolean): Promise<void> => {		if (!store) return;
		try {
			await rpc.request("session.revertTo", { sessionId: store.sessionId, messageId });
			await onReloadSession?.();
			setRevertHistory(prev => [...prev, { id: crypto.randomUUID(), messageId, text, at: Date.now() }]);
		} catch {
			// daemon rejected — keep the transcript as-is
		}
	};
	const restoreReverted = (id: string, text: string): void => {
		setRevertHistory(prev => prev.filter(r => r.id !== id));
		setPendingEdit(text);
	};
	const resendReverted = (id: string, text: string): void => {
		setRevertHistory(prev => prev.filter(r => r.id !== id));
		onSend(text, undefined, "followUp");
	};
	const discardReverted = (id: string): void => {
		setRevertHistory(prev => prev.filter(r => r.id !== id));
	};
	// Fork (分叉): non-destructive — copy the session truncated to before
	// this message into a NEW session, then open it. The parent is intact.
	const forkFromMessage = async (messageId: string): Promise<void> => {
		if (!store) return;
		try {
			const res = await rpc.request<{ sessionId: string; parentId: string }>("session.forkAt", {
				sessionId: store.sessionId,
				messageId,
			});
			if (res?.sessionId) await onForkSession?.(res.sessionId);
		} catch {
			// daemon rejected (unknown message/session) — keep as-is
		}
	};
	// Live thinking level: the daemon records thinking_level_change entries
	// but never mutates state.thinkingLevel, so derive the current level from
	// the LAST change entry — the composer chip updates the moment the entry
	// lands, without a transcript marker row.
	const thinkingLevel: string | null = (() => {
		if (!snap) return null;
		let level: string | null = snap.state?.thinkingLevel ?? null;
		for (const entry of snap.entries) {
			if (entry.type === "thinking_level_change") level = entry.thinkingLevel ?? null;
		}
		return level;
	})();
	const host = {
		hasAgent: () => false,
		openAgent: () => {},
		// Inline widgets hand results back to the conversation (kimi
		// sendPrompt parity) — same path as the composer.
		sendPrompt: (text: string) => onSend(text),
	};
	// Per-model thinking ceiling + exact ladder (TUI /model parity): higher
	// ladder rungs are disabled in the composer's ThinkingSelector, and the
	// ladder itself is the current model's supported efforts. GuiHeader runs
	// the same query for its title label; this one feeds the selector.
	const [thinkingCeiling, setThinkingCeiling] = useState<string | null>(null);
	const [thinkingEfforts, setThinkingEfforts] = useState<string[] | null>(null);
	useEffect(() => {
		if (!store) return;
		let cancelled = false;
		void rpc
			.request<{ ceiling?: string | null; efforts?: string[] }>("session.thinkingInfo", {
				sessionId: store.sessionId,
			})
			.then(info => {
				if (cancelled) return;
				setThinkingCeiling(info?.ceiling ?? null);
				setThinkingEfforts(info?.efforts?.length ? info.efforts : []);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [rpc, store]);
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
			{/* Window drag strip: the 8px margin above the floating surface
			 * plus the header's blank areas stay draggable (openchamber
			 * app-region-drag header); every button inside is no-drag. */}
			<div className="gui-drag-strip" aria-hidden />
			{/* The single rounded floating app surface — both scenes live in it.
			 * The window header (GuiHeader) is a separate container ABOVE it. */}
			<div className="gui-chat-surface m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
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
							presetModelId={presetModelId}
							onSubmit={(text, opts) => onSubmitNewSession(text, opts)}
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
										<div
											ref={transcriptRef}
											className="gui-transcript min-h-0 min-w-0 h-full overflow-y-auto px-5 py-4"
											data-top-scroll="false"
											data-bottom-scroll="false"
										>
											<CodeHighlightProvider highlight={chatHighlight}>
												{/* Revert-history list (会话内顶部): every revert lands here
												 * with 恢复(回填输入框)/重新发送/丢弃 — the old pencil
												 * button merged into this. */}
												{revertHistory.length > 0 && (
													<div
														className="gui-revert-list"
														role="region"
														aria-label={t("reverted messages")}
													>
														{revertHistory.map(r => (
															<div key={r.id} className="gui-revert-item">
																<Icon
																	name="arrow-go-back"
																	className="h-3 w-3 flex-shrink-0 text-[var(--color-warning)]"
																/>
																<span className="gui-revert-item-text" title={r.text}>
																	{r.text}
																</span>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("restore into the input")}
																	onClick={() => restoreReverted(r.id, r.text)}
																>
																	<Icon name="arrow-go-back" className="h-3 w-3" />
																</button>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("resend")}
																	onClick={() => resendReverted(r.id, r.text)}
																>
																	<Icon name="send-plane" className="h-3 w-3" />
																</button>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("continue from this point in a new session")}
																	onClick={() => void forkFromMessage(r.messageId)}
																>
																	<Icon name="git-branch" className="h-3 w-3" />
																</button>
																<button
																	type="button"
																	className="gui-pane-action !w-auto px-1.5"
																	title={t("discard")}
																	onClick={() => discardReverted(r.id)}
																>
																	<Icon name="close" className="h-3 w-3" />
																</button>
															</div>
														))}
													</div>
												)}
												<Transcript
													entries={snap?.entries ?? []}
													/* No stream ghost: the view folds the assistant message into
													 * entries at message_start, so the entry row IS the live
													 * stream renderer (immutable upserts re-render it). */
													stream={null}
													streamDone={true}
													activeTools={snap?.activeTools ?? new Map()}
													working={snap?.working ?? false}
													host={host}
													/* Chat settings (openchamber parity): user message
													 * markdown/plain + long-message collapse. */
													userPlain={(() => {
														try {
															return localStorage.getItem("omp-gui-chat-usermsg") === "plain";
														} catch {
															return false;
														}
													})()}
													collapseLongUserMessages={(() => {
														try {
															return localStorage.getItem("omp-gui-chat-collapseuser") !== "0";
														} catch {
															return true;
														}
													})()}
													onQuote={text => setPendingQuote(text)}
													onRevert={(id, text) => void revertToMessage(id, text, false)}
													onFork={id => void forkFromMessage(id)}
													onRetry={onSend}
													onSpeak={text => {
														// TTS read-aloud via the daemon's local Kokoro worker.
														speak(text, rpc);
													}}
													onSaveImage={text => {
														// Render the reply as a text card and push it to the
														// clipboard as PNG (openchamber 保存为图片 parity).
														void saveMessageAsImage(text);
													}}
													/* ZCode: avatars replace the 宿主/代理 gutter labels. */
													userGutter={showAvatars ? <UserAvatar rpc={rpc} cwd={store.cwd} /> : ""}
													agentGutter={showAvatars ? <AgentAvatar state={orb} size={64} /> : ""}
												/>
											</CodeHighlightProvider>
										</div>
										{/* Jump-to-bottom (openchamber ScrollToBottomButton parity):
										 * floats over the composer edge while scrolled up. */}
										<JumpToBottomButton rootRef={transcriptRef} />
										{/* In-message text selection actions (openchamber parity):
										 * quote a snippet (not the whole message), copy, start a
										 * new session from it, or append it to the workspace notes. */}
										<SelectionToolbar
											containerRef={transcriptRef}
											onQuote={text => setPendingQuote(text)}
											onCopy={text => void navigator.clipboard.writeText(text)}
											onNewSession={text => onSubmitNewSession(text)}
											onAddNote={text => {
												const cwd = store.cwd;
												void rpc
													.request<{ text: string }>("notes.get", { cwd })
													.then(res => {
														const existing = res?.text ?? "";
														const next = existing ? `${existing}\n\n> ${text}` : `> ${text}`;
														return rpc.request("notes.set", { cwd, text: next });
													})
													.catch(() => {});
											}}
										/>
										{/* Idle recap (TUI `※ recap:` status-line parity): the daemon
										 * generates it after recap.idleSeconds of quiet; fixed below
										 * the transcript, cleared by the next wire activity or the
										 * dismiss button. */}
										{snap?.recap && (
											<div className="gui-recap-row" title={t("idle recap")}>
												<span className="gui-recap-prefix">※</span>
												<span className="gui-recap-text">{snap.recap.text}</span>
												<span className="gui-recap-time">{relTime(snap.recap.at)}</span>
												<button
													type="button"
													className="gui-recap-dismiss"
													title={t("dismiss")}
													aria-label={t("dismiss")}
													onClick={() => store?.dismissRecap()}
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
									{snap?.approvals.map(a => (
										<ApprovalCard
											key={a.requestId}
											requestId={a.requestId}
											tool={a.tool}
											onDecide={onDecideApproval}
										/>
									))}
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
										thinkingCeiling={thinkingCeiling}
										thinkingEfforts={thinkingEfforts}
										presetModelId={presetModelId}
										pendingQuote={pendingQuote}
										onQuoteConsumed={() => setPendingQuote(null)}
										pendingEdit={pendingEdit}
										onEditConsumed={() => setPendingEdit(null)}
										focused={focusMode}
										onToggleFocus={onToggleFocus}
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
							/>
						</div>
					</div>
				)}
				{terminalOpen && (
					<div
						className="gui-terminal-dock relative flex flex-shrink-0 flex-col overflow-hidden border-t border-[var(--border)]"
						style={{ height: dockHeight }}
					>
						{/* Drag handle: the dock pushes the composer up and its
						 * height is user-adjustable (openchamber bottom dock). */}
						<div className="gui-dock-handle" onPointerDown={dockResize} aria-hidden />
						<TerminalPanel rpc={rpc} cwd={store?.cwd ?? project ?? ""} />
					</div>
				)}
			</div>
		</main>
	);
}
