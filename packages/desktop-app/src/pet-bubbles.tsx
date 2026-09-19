/**
 * Pet window overlay surfaces (bubbles + interaction panel) — merged into
 * the pet window (single window, 2026-09-16; formerly bubble.html, 双窗口).
 *
 * The old split (dedicated bubble window chasing the pet window on every
 * move) is what made the pet and its bubbles drift apart on non-100%
 * scaling: two windows, two coordinate transformations, one of them
 * guessed at runtime. In the merged window the bubbles/panel are plain
 * DOM layered above the sprite — their position relative to the pet is
 * CSS, structurally immune to any DPI/scaling issue.
 *
 * Sizing: the window is 320 wide (panel 316 / stack 280 both fit) and
 * grows UPWARD when the overlay content needs more room — the renderer
 * reports the required height via setPetContentSize and the main process
 * keeps the bottom edge fixed (the sprite is anchored to it), so the pet
 * never moves on screen while bubbles open/close above it.
 */

import { setLocale, t } from "@musepi/guest-client";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PetActivity } from "./lib/pet";
import { useScrollShadow } from "./lib/use-scroll-shadow";

interface PetBubblesBridge {
	onPetActivity?(cb: (payload: PetActivity) => void): () => void;
	/** Context menu / pet click → toggle the panel (the panel lives here). */
	onPetPanelToggle?(cb: () => void): () => void;
	/** A global approval hotkey decided a request — drop the card. */
	onPetApprovalResolved?(cb: (payload: { requestId: string; approved: boolean }) => void): () => void;
	petReply?(text: string, sessionId?: string): Promise<unknown>;
	petApprove?(requestId: string, approved: boolean): Promise<unknown>;
	focusMainWindow?(): Promise<unknown>;
	petOpenSession?(sessionId: string): Promise<unknown>;
	/** Bubble × dismiss → mark that session read (the main window owns the
	 *  unread badge; dismissing the notification must clear it too). */
	petMarkRead?(sessionId: string): Promise<unknown>;
	petGetSessionContent?(sessionId: string): Promise<unknown>;
	onPetSessionContent?(
		cb: (payload: { sessionId: string; messages: Array<{ role: string; text: string }>; loaded?: boolean }) => void,
	): () => void;
	/** Report the window height the overlay content needs (CSS px). */
	setPetContentSize?(size: { height: number }): Promise<unknown>;
	/** Ask the main window to re-push its latest pet state (panel opens
	 *  with stale/absent state otherwise — state only re-pushes on change). */
	requestPetState?(): Promise<unknown>;
}

const BUBBLE_MS = 8000;
const MAX_VISIBLE_BUBBLES = 5;
/** Base window height (main.cjs PET_WINDOW_SIZE) — reported when the
 *  overlay is empty so the window shrinks back down. */
const BASE_WINDOW_HEIGHT = 290;
/** Head-room above the topmost overlay element: card shadows (0 4px 16px)
 *  and the stack-chip overhang (-9px) must not clip at the window edge. */
const CONTENT_TOP_PAD = 12;

interface Bubble {
	id: number;
	kind: string;
	text: string;
	/** Session this notification belongs to — click opens it directly. */
	sessionId?: string;
	visible: string;
}

/** Short tag shown on each card so the four notification kinds are
 *  distinguishable at a glance. The KIND is the severity signal — a finished
 *  task and a question that blocks the agent used to render identically
 *  (only `error` carried any styling at all). Unknown kinds get no tag
 *  rather than a misleading one: the daemon may add kinds before this
 *  window learns about them. */
function bubbleKindLabel(kind: string): string | null {
	switch (kind) {
		case "completed":
			return t("pet bubble kind completed");
		case "error":
			return t("pet bubble kind error");
		case "question":
			return t("pet bubble kind question");
		case "subtask":
			return t("pet bubble kind subtask");
		default:
			return null;
	}
}

interface PendingApproval {
	requestId: string;
	tool: string;
}

/** Compact relative time for the recent-session rows. */
function relTimeLabel(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function PetBubbles(): ReactNode {
	const [bubbles, setBubbles] = useState<Bubble[]>([]);
	// iOS Notification-Center style: collapsed shows the newest bubble +
	// "N more" count chip; clicking expands the full list.
	const [stackExpanded, setStackExpanded] = useState(false);
	// Size morph between the collapsed card and the expanded list (iOS
	// Notification-Center style): capture the old size on switch, render
	// the new view locked to that size, then transition to the new one.
	const [stackMorph, setStackMorph] = useState<{ from: { width: number; height: number } } | null>(null);
	const stackRef = useRef<HTMLDivElement | null>(null);
	// Interaction panel: live task summary + approval card + quick reply.
	const [panelOpen, setPanelOpen] = useState(false);
	const [panelEntered, setPanelEntered] = useState(false);
	const [panelLeaving, setPanelLeaving] = useState(false);
	// Panel view split (拆开): "messages" = live status/message/approvals/
	// reply; "sessions" = the recent-session list, its own view.
	const [panelView, setPanelView] = useState<"messages" | "sessions">("messages");
	const [petState, setPetState] = useState<PetActivity["state"] | null>(null);
	const [approvals, setApprovals] = useState<PendingApproval[]>([]);
	const [recentSessions, setRecentSessions] = useState<{ id: string; label: string; timestamp: number }[]>([]);
	const [activeSession, setActiveSession] = useState<{
		id: string;
		label: string;
		messages: Array<{ role: string; text: string }>;
		loaded: boolean;
	} | null>(null);
	const [replyText, setReplyText] = useState("");
	const [sending, setSending] = useState(false);
	const bridge = (window as unknown as { electronAPI?: PetBubblesBridge }).electronAPI;

	const sessionMessages = useMemo(() => {
		if (!activeSession?.loaded || !activeSession.messages.length) return null;
		return activeSession.messages.map((m, i) => (
			<div key={i} className={`pet-panel__msg pet-panel__msg--${m.role}`}>
				{m.text}
			</div>
		));
	}, [activeSession?.loaded, activeSession?.messages]);

	// pet:activity — bubbles, approvals, session state, theme/locale push.
	useEffect(() => {
		const off = bridge?.onPetActivity?.(payload => {
			if (payload.state) setPetState(payload.state);
			if (payload.approval?.requestId) {
				setApprovals(prev =>
					prev.some(a => a.requestId === payload.approval!.requestId)
						? prev
						: [...prev, { requestId: payload.approval!.requestId, tool: payload.approval!.tool }],
				);
			}
			if (payload.bubble?.text) {
				const bubble = payload.bubble;
				const id = Date.now();
				setBubbles(prev => {
					const next = bubble.sessionId
						? // Replace the prior bubble for this session — each session
							// shows only its latest completion/error, not an ever-growing
							// stack. Transient bubbles (no sessionId) still append.
							prev.some(b => b.sessionId === bubble.sessionId)
							? prev.map(b =>
									b.sessionId === bubble.sessionId
										? {
												id: b.id,
												kind: bubble.kind,
												text: bubble.text,
												sessionId: bubble.sessionId,
												visible: "",
											}
										: b,
								)
							: [...prev, { id, kind: bubble.kind, text: bubble.text, sessionId: bubble.sessionId, visible: "" }]
						: [...prev, { id, kind: bubble.kind, text: bubble.text, sessionId: bubble.sessionId, visible: "" }];
					return next.length > MAX_VISIBLE_BUBBLES ? next.slice(next.length - MAX_VISIBLE_BUBBLES) : next;
				});
				// Completion/error bubbles persist until dismissed or the
				// session is opened (the unread badge tracks them); transient
				// kinds auto-dismiss as before.
				if (bubble.kind === "completed" || bubble.kind === "error") return;
				window.setTimeout(() => {
					setBubbles(prev => prev.filter(b => b.id !== id));
				}, BUBBLE_MS);
			}
			if (typeof payload.locale === "string") setLocale(payload.locale);
			// Sessions opened in the main window are read — dismiss their
			// completion/error bubbles (read 闭环: opening a session in the
			// main window clears the pet's notification for it).
			if (Array.isArray(payload.dismissSessions) && payload.dismissSessions.length > 0) {
				const ids = new Set(payload.dismissSessions);
				setBubbles(prev => {
					const next = prev.filter(b => !(b.sessionId && ids.has(b.sessionId)));
					return next.length === prev.length ? prev : next;
				});
			}
			if (payload.theme === "light" || payload.theme === "dark") {
				document.documentElement.dataset.theme = payload.theme;
				document.documentElement.dataset.colorScheme = payload.theme;
				document.documentElement.style.colorScheme = payload.theme;
			}
			// Recent-session list for the panel.
			if (Array.isArray(payload.recentSessions)) setRecentSessions(payload.recentSessions);
		});
		// Ask the main window for the latest session state — the panel is
		// useless with a stale/absent state (title, idle/working, last
		// message). The main window re-pushes on request (pet:state-request).
		void bridge?.requestPetState?.();
		return off;
	}, []);

	// Panel toggle from the pet single click / the context menu — now an
	// in-window event (no OS-window hop through the main process).
	useEffect(() => {
		return bridge?.onPetPanelToggle?.(() => {
			if (panelOpen) {
				setPanelLeaving(true);
				window.setTimeout(() => {
					setPanelLeaving(false);
					setPanelOpen(false);
					setApprovals([]);
				}, 140);
			} else {
				setPanelOpen(true);
				// Fresh state on every open — idle sessions push state only on
				// change, so an old panel would show a stale title/message.
				void bridge?.requestPetState?.();
			}
		});
	}, [panelOpen]);

	// A global hotkey (Ctrl/Cmd+Shift+Y / N) decided a request — drop the
	// card (the main window was already told via pet:command).
	useEffect(() => {
		return bridge?.onPetApprovalResolved?.(({ requestId }) => {
			setApprovals(prev => prev.filter(a => a.requestId !== requestId));
		});
	}, []);

	// Transcript for the session opened from the recent list.
	useEffect(() => {
		return bridge?.onPetSessionContent?.(payload => {
			setActiveSession(prev =>
				prev && prev.id === payload.sessionId
					? { ...prev, messages: payload.messages, loaded: payload.loaded === true }
					: prev,
			);
		});
	}, []);

	// Light/dark scheme mirror (same as the pet window).
	useEffect(() => {
		const doc = document.documentElement;
		const applyScheme = (): void => {
			let pref: "system" | "light" | "dark" = "system";
			try {
				const v = localStorage.getItem("omp-collab-theme");
				if (v === "light" || v === "dark" || v === "system") pref = v;
			} catch {
				/* storage unavailable — follow the system */
			}
			const resolved =
				pref === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref;
			doc.dataset.theme = resolved;
			doc.dataset.colorScheme = resolved;
			doc.style.colorScheme = resolved;
		};
		applyScheme();
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onMq = (): void => {
			try {
				if ((localStorage.getItem("omp-collab-theme") ?? "system") === "system") applyScheme();
			} catch {
				applyScheme();
			}
		};
		mq.addEventListener("change", onMq);
		return () => mq.removeEventListener("change", onMq);
	}, []);

	// Typewriter reveal for every bubble (one interval, all bubbles).
	useEffect(() => {
		if (bubbles.length === 0 || bubbles.every(b => b.visible === b.text)) return;
		const timer = window.setInterval(() => {
			setBubbles(prev => {
				let changed = false;
				const next = prev.map(b => {
					if (b.visible === b.text) return b;
					const gap = b.text.length - b.visible.length;
					const step = Math.max(1, Math.floor(gap / 6));
					changed = true;
					return { ...b, visible: b.text.slice(0, b.visible.length + step) };
				});
				return changed ? next : prev;
			});
		}, 28);
		return () => window.clearInterval(timer);
	}, [bubbles]);

	// Report the height the overlay content needs — the main process grows
	// the window UPWARD (bottom edge fixed), so the sprite never moves.
	// Only the top edge matters: panel/bubbles sit above the pet, and the
	// window must extend far enough up that their top (+ shadow/chip
	// head-room) stays inside the window.
	useEffect(() => {
		if (!bridge?.setPetContentSize) return;
		const report = (): void => {
			let minTop = Infinity;
			for (const el of document.querySelectorAll<HTMLElement>(".pet-bubbles, .pet-panel")) {
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				// Entrance/leaving keyframes transform the box; getBoundingClientRect
				// includes the transform, so a mid-animation report would size the
				// window to the animating (shrunk) box. The layout box (offsetTop)
				// ignores transforms — use it while the element animates; the
				// animationend re-report below settles the final size.
				minTop = Math.min(
					minTop,
					typeof el.getAnimations === "function" && el.getAnimations().some(a => a.playState === "running")
						? el.offsetTop
						: r.top,
				);
			}
			const needed =
				minTop === Infinity ? BASE_WINDOW_HEIGHT : BASE_WINDOW_HEIGHT + Math.max(0, CONTENT_TOP_PAD - minTop);
			void bridge.setPetContentSize?.({ height: Math.ceil(needed) });
			// Transforms do not fire ResizeObserver — re-report when an
			// entrance/leaving animation settles.
			for (const el of document.querySelectorAll<HTMLElement>(".pet-panel, .pet-bubbles")) {
				el.addEventListener("animationend", report, { once: true });
			}
		};
		const ro = new ResizeObserver(report);
		for (const el of document.querySelectorAll(".pet-bubbles, .pet-panel")) ro.observe(el);
		report();
		// Delayed re-reports: typewriter growth / panel entrance change the
		// box after mount; the mutation observer catches newly mounted
		// content elements (bubbles appear/disappear, stack expands) and
		// characterData picks up the typewriter's per-tick text growth.
		const timer = window.setTimeout(report, 300);
		const mo = new MutationObserver(report);
		const root = document.getElementById("root");
		if (root) mo.observe(root, { childList: true, subtree: true, characterData: true });
		return () => {
			ro.disconnect();
			mo.disconnect();
			window.clearTimeout(timer);
		};
	}, []);

	// Collapsed ⇄ expanded with a size morph: capture the old size,
	// swap the view (renderer locks the container to `from` via the
	// inline style), then measure the target size and transition.
	const switchStack = (next: boolean): void => {
		if (next === stackExpanded) return;
		const r = stackRef.current?.getBoundingClientRect();
		setStackExpanded(next);
		setStackMorph(r ? { from: { width: r.width, height: r.height } } : null);
	};

	// Expanded list scroll feather (transcript parity): the stack scrolls
	// inside the window, and data-top-scroll / data-bottom-scroll flip the
	// mask-image top/bottom fade on as content overflows and scrolls away
	// from an edge — no hard-cut rows at the scrollport.
	useScrollShadow(stackRef);

	useEffect(() => {
		if (!stackMorph) return;
		const el = stackRef.current;
		if (!el) return;
		// The renderer locks the container to `from` (inline size).
		// Measuring needs the TRUE content size: scrollHeight bottoms
		// out at the locked client height and the locked width masks the
		// max-content target, so lift the lock, measure, then re-lock —
		// same frame, no paint in between.
		el.style.transition = "none";
		el.style.width = "";
		el.style.height = "";
		const toW = el.getBoundingClientRect().width;
		const toH = el.getBoundingClientRect().height;
		el.style.width = `${stackMorph.from.width}px`;
		el.style.height = `${stackMorph.from.height}px`;
		void el.offsetHeight; // commit the lock before transitioning
		if (Math.abs(toH - stackMorph.from.height) < 1 && Math.abs(toW - stackMorph.from.width) < 1) {
			setStackMorph(null);
			return;
		}
		// Spring with overshoot (cubic-bezier y > 1) — the size sweeps
		// past the target and settles back (iOS Notification-Center bounce).
		el.style.transition =
			"width 320ms cubic-bezier(0.34, 1.4, 0.64, 1), height 320ms cubic-bezier(0.34, 1.4, 0.64, 1)";
		el.style.width = `${toW}px`;
		el.style.height = `${toH}px`;
		const done = (): void => {
			el.style.transition = "";
			el.style.width = "";
			el.style.height = "";
			setStackMorph(null);
		};
		el.addEventListener("transitionend", done, { once: true });
		const fallback = window.setTimeout(done, 420);
		return () => {
			window.clearTimeout(fallback);
			el.removeEventListener("transitionend", done);
		};
	}, [stackMorph]);

	// Panel entrance waits for the OS window resize. The panel mounts while
	// the window is still base-sized: an immediate entrance animation would
	// paint the panel clipped to the old window. The window resize event is
	// the sync point (the growth is one setBounds round-trip behind the
	// React commit); the 120ms fallback covers a window that was already
	// panel-sized or a missed event.
	useEffect(() => {
		if (!panelOpen) return;
		setPanelEntered(false);
		let settled = false;
		const enter = (): void => {
			if (settled) return;
			settled = true;
			setPanelEntered(true);
		};
		window.addEventListener("resize", enter);
		const fallback = window.setTimeout(enter, 120);
		return () => {
			window.removeEventListener("resize", enter);
			window.clearTimeout(fallback);
		};
	}, [panelOpen]);

	const closePanel = (): void => {
		setPanelLeaving(true);
		window.setTimeout(() => {
			setPanelLeaving(false);
			setPanelOpen(false);
			setApprovals([]);
		}, 140);
	};

	const sendReply = (): void => {
		const text = replyText.trim();
		if (!text || sending) return;
		setSending(true);
		void bridge?.petReply?.(text, activeSession?.id).finally(() => {
			setSending(false);
			setReplyText("");
		});
	};

	const decide = (requestId: string, approved: boolean): void => {
		void bridge?.petApprove?.(requestId, approved);
		setApprovals(prev => prev.filter(a => a.requestId !== requestId));
	};

	if (panelOpen) {
		return (
			<div
				className={`pet-panel${panelEntered ? " pet-panel--in" : ""}${panelLeaving ? " pet-panel--leaving" : ""}`}
			>
				<div className="pet-panel__head">
					<span
						className="pet-panel__title"
						title={panelView === "sessions" ? t("recent sessions") : (petState?.sessionTitle ?? undefined)}
					>
						{panelView === "sessions"
							? t("recent sessions")
							: petState?.sessionTitle
								? petState.sessionTitle
								: t("MusePi")}
					</span>
					<div className="pet-panel__head-actions">
						{petState && (
							<button
								type="button"
								className="pet-panel__open"
								aria-label={t("pet open main window")}
								title={t("pet open main window")}
								onClick={() => void bridge?.focusMainWindow?.()}
							>
								↗
							</button>
						)}
						<button
							type="button"
							className="pet-panel__close"
							aria-label={t("pet close panel")}
							onClick={closePanel}
						>
							×
						</button>
					</div>
				</div>
				<div className="pet-panel__tabs" role="tablist" aria-label="panel views">
					<button
						type="button"
						role="tab"
						aria-selected={panelView === "messages"}
						className={`pet-panel__tab${panelView === "messages" ? " pet-panel__tab--active" : ""}`}
						onClick={() => setPanelView("messages")}
					>
						{t("pet panel messages")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={panelView === "sessions"}
						className={`pet-panel__tab${panelView === "sessions" ? " pet-panel__tab--active" : ""}`}
						onClick={() => setPanelView("sessions")}
					>
						{t("pet panel sessions")}
					</button>
				</div>
				<div className="pet-panel__body">
					{panelView === "sessions" ? (
						// 会话视图：最近活跃会话列表（拆开的独立面板视图）。
						<div className="pet-panel__sessions">
							{recentSessions.length === 0 ? (
								<div className="pet-panel__sessions-empty">{t("pet panel no recent")}</div>
							) : (
								recentSessions.slice(0, 5).map(rs => (
									<button
										key={rs.id}
										type="button"
										className="pet-panel__recent-row"
										title={rs.label}
										onClick={() => {
											// Open the session transcript in the
											// messages view; the tab is the way back.
											setActiveSession({
												id: rs.id,
												label: rs.label || t("untitled session"),
												messages: [],
												loaded: false,
											});
											setPanelView("messages");
											void bridge?.petGetSessionContent?.(rs.id);
										}}
									>
										<span className="pet-panel__recent-label">{rs.label || t("untitled session")}</span>
										<span className="pet-panel__recent-time">{relTimeLabel(rs.timestamp)}</span>
									</button>
								))
							)}
						</div>
					) : activeSession ? (
						<div className="pet-panel__session">
							<div className="pet-panel__session-head">
								<button
									type="button"
									className="pet-panel__back"
									aria-label={t("back to chat")}
									title={t("back to chat")}
									onClick={() => setActiveSession(null)}
								>
									←
								</button>
								<div className="pet-panel__session-title" title={activeSession.label}>
									{activeSession.label}
								</div>
							</div>
							<div className="pet-panel__session-msgs">
								{!activeSession.loaded ? (
									<div className="pet-panel__session-empty">{t("loading…")}</div>
								) : activeSession.messages.length === 0 ? (
									<div className="pet-panel__session-empty">{t("no messages yet")}</div>
								) : (
									sessionMessages
								)}
							</div>
							{/* Quick reply steers THIS session (sendReply already
							 * routes to activeSession.id) — viewing a session in
							 * the panel must let you answer it without leaving. */}
							<div className="pet-panel__reply">
								<input
									className="pet-panel__reply-input"
									placeholder={t("pet reply placeholder")}
									value={replyText}
									onChange={e => setReplyText(e.target.value)}
									onKeyDown={e => {
										if (e.key === "Enter") sendReply();
									}}
								/>
								<button
									type="button"
									className="pet-panel__reply-send"
									aria-label={t("send")}
									onClick={sendReply}
									disabled={!replyText.trim() || sending}
								>
									{t("send")}
								</button>
							</div>
						</div>
					) : (
						<>
							{/* Live task summary */}
							<div className="pet-panel__status">
								<div
									className={`pet-panel__status-dot${petState?.working ? " pet-panel__status-dot--working" : ""}`}
									aria-hidden="true"
								/>
								{petState?.working ? (
									<span className="pet-panel__status-text">
										{petState.toolName
											? t("pet working · {tool}", { tool: petState.toolName })
											: t("working")}
									</span>
								) : (
									<span className="pet-panel__status-text">{t("idle")}</span>
								)}
							</div>
							{petState?.lastMessage && <div className="pet-panel__message">{petState.lastMessage}</div>}
							{/* Pending approvals */}
							{approvals.length > 0 && (
								<div className="pet-panel__approvals">
									{approvals.map(a => (
										<div key={a.requestId} className="pet-panel__approval">
											<div className="pet-panel__approval-tool">
												{t("pet approval · {tool}", { tool: a.tool })}
											</div>
											<div className="pet-panel__approval-actions">
												<button
													type="button"
													className="pet-panel__btn pet-panel__btn--allow"
													onClick={() => decide(a.requestId, true)}
												>
													{t("Approve")}
												</button>
												<button
													type="button"
													className="pet-panel__btn pet-panel__btn--deny"
													onClick={() => decide(a.requestId, false)}
												>
													{t("Deny")}
												</button>
											</div>
										</div>
									))}
								</div>
							)}
							{/* Quick reply — steers the active session. */}
							<div className="pet-panel__reply">
								<input
									className="pet-panel__reply-input"
									placeholder={t("pet reply placeholder")}
									value={replyText}
									onChange={e => setReplyText(e.target.value)}
									onKeyDown={e => {
										if (e.key === "Enter") sendReply();
									}}
								/>
								<button
									type="button"
									className="pet-panel__reply-send"
									aria-label={t("send")}
									onClick={sendReply}
									disabled={!replyText.trim() || sending}
								>
									{t("send")}
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		);
	}

	if (bubbles.length === 0) return null;

	// iOS Notification-Center stack: collapsed shows only the newest
	// bubble (count chip when more pending); expanded shows the full list
	// (scrolls within the window).
	return stackExpanded ? (
		<div
			ref={stackRef}
			className={`pet-bubbles pet-bubbles--expanded${stackMorph ? " pet-bubbles--morphing" : ""}`}
			style={stackMorph ? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` } : undefined}
			data-top-scroll="false"
			data-bottom-scroll="false"
			aria-live="polite"
		>
			<div className="pet-bubbles__head" role="button" tabIndex={0} onClick={() => switchStack(false)}>
				<span className="pet-bubbles__count">{t("pet bubbles count", { count: bubbles.length })}</span>
				<span className="pet-bubbles__collapse">{t("pet bubbles collapse")} ▾</span>
			</div>
			{[...bubbles].reverse().map(b => (
				<div
					key={b.id}
					className={`pet-bubble pet-bubble--${b.kind}`}
					onClick={() => {
						// Completion/error bubbles carry their session: click
						// opens it in the main window (that's the "read" action)
						// and dismisses them. Plain notifications just focus.
						if (b.sessionId && (b.kind === "completed" || b.kind === "error")) {
							void bridge?.petOpenSession?.(b.sessionId);
							setBubbles(prev => prev.filter(x => x.sessionId !== b.sessionId));
							return;
						}
						void bridge?.focusMainWindow?.();
					}}
				>
					<button
						type="button"
						className="pet-bubble__dismiss"
						aria-label="dismiss"
						onClick={e => {
							e.stopPropagation();
							// Dismissing a completion/error notification also
							// clears its unread badge in the main window —
							// bubble and badge track the same signal.
							if ((b.kind === "completed" || b.kind === "error") && b.sessionId) {
								void bridge?.petMarkRead?.(b.sessionId);
							}
							setBubbles(prev => prev.filter(x => x.id !== b.id));
						}}
					>
						×
					</button>
					<div className="pet-bubble__text">{b.visible}</div>
					{bubbleKindLabel(b.kind) && <span className="pet-bubble__kind">{bubbleKindLabel(b.kind)}</span>}
				</div>
			))}
		</div>
	) : (
		<div
			ref={stackRef}
			className={`pet-bubbles pet-bubbles--stacked${stackMorph ? " pet-bubbles--morphing pet-bubbles--shrinking" : ""}`}
			style={stackMorph ? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` } : undefined}
			aria-live="polite"
		>
			{(() => {
				const top = bubbles[bubbles.length - 1];
				const more = bubbles.length - 1;
				return (
					<div
						className={`pet-bubble pet-bubble--${top.kind}${more > 0 ? " pet-bubble--stacked" : ""}`}
						// Clicking the stacked card EXPANDS the list.
						onClick={() => switchStack(true)}
					>
						{more > 0 && <span className="pet-bubble__more">{t("pet bubbles more", { count: more })}</span>}
						<button
							type="button"
							className="pet-bubble__dismiss"
							aria-label="dismiss"
							onClick={e => {
								e.stopPropagation();
								// Same read 闭环 as the expanded list: dismiss
								// also clears that session's unread badge.
								if ((top.kind === "completed" || top.kind === "error") && top.sessionId) {
									void bridge?.petMarkRead?.(top.sessionId);
								}
								setBubbles(prev => prev.filter(x => x.id !== top.id));
							}}
						>
							×
						</button>
						<div className="pet-bubble__text">{top.visible}</div>
						{bubbleKindLabel(top.kind) && <span className="pet-bubble__kind">{bubbleKindLabel(top.kind)}</span>}
					</div>
				);
			})()}
		</div>
	);
}
