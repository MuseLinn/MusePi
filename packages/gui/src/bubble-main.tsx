/**
 * Bubble/panel window entry (bubble.html) — the pet's overlay surfaces in
 * their OWN window, split from the pet window (双窗口):
 *
 *   - pet window (pet.html): the companion sprite, fully transparent,
 *     click-through outside the sprite — floats on the desktop.
 *   - bubble window (bubble.html, THIS file): the activity bubbles (iOS
 *     Notification-Center stack) and the interaction panel, on a REAL
 *     vibrancy glass surface — a transparent + vibrancy window sized to
 *     exactly its content, positioned above the pet.
 *
 * Splitting the windows lets each one use its ideal material: the pet
 * stays a transparent sprite (vibrancy would render the whole window as
 * an opaque glass panel), while the bubbles/panel get native frosted
 * glass without a giant glass rectangle behind the pet.
 *
 * State flows over IPC from the main process (which forwards the main
 * window's pet:activity pushes to BOTH windows): bubbles, approvals,
 * session state for the panel, and the panel toggle from pet clicks /
 * the pet context menu. The window reports its content size so the main
 * process keeps the OS window exactly content-sized (a floating glass
 * card, never a glass rectangle).
 */

import { setLocale, t } from "@musepi/collab-web";
import { type ReactNode, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initTooltips } from "./lib/tooltips";
import type { PetActivity } from "./lib/pet";

import "./styles/pet-window.css";
import "./styles/gui.css";

interface BubbleBridge {
	onPetActivity?(cb: (payload: PetActivity) => void): () => void;
	onPetPanelToggle?(cb: () => void): () => void;
	petSetPanel?(open: boolean): Promise<unknown>;
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
	/** Report the content bounding box (CSS px) so the main process can
	 *  size the OS window to exactly the bubbles/panel (glass card). */
	setBubbleSize?(rect: { width: number; height: number } | null): Promise<unknown>;
	/** Ask the main window to re-push its latest pet state (panel opens
	 *  with stale/absent state otherwise — state only re-pushes on change). */
	requestPetState?(): Promise<unknown>;
}

const BUBBLE_MS = 8000;
const MAX_VISIBLE_BUBBLES = 5;

interface Bubble {
	id: number;
	kind: string;
	text: string;
	/** Session this notification belongs to — click opens it directly. */
	sessionId?: string;
	visible: string;
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

function BubbleApp(): ReactNode {
	const [bubbles, setBubbles] = useState<Bubble[]>([]);
	// iOS Notification-Center style: collapsed shows the newest bubble +
	// "N more" count chip; clicking expands the full list.
	const [stackExpanded, setStackExpanded] = useState(false);
	// Size morph between the collapsed card and the expanded list (iOS
	// Notification-Center style): capture the old size on switch, render
	// the new view locked to that size, then transition to the new one.
	// Width too: the collapsed card and the expanded list are different
	// content (newest bubble vs. the widest row), so a height-only morph
	// leaves a visible width jump (morphsize/FLIP).
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
	const bridge = (window as unknown as { electronAPI?: BubbleBridge }).electronAPI;
	const rootRef = useRef<HTMLDivElement>(null);

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
					const next = [
						...prev,
						{ id, kind: bubble.kind, text: bubble.text, sessionId: bubble.sessionId, visible: "" },
					];
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
			// Recent-session list for the panel — dropped in the window
			// split (the pet window used to consume it); without this the
			// panel's 最近活跃会话 section never renders.
			if (Array.isArray(payload.recentSessions)) setRecentSessions(payload.recentSessions);
		});
		// Ask the main window for the latest session state — the panel is
		// useless with a stale/absent state (title, idle/working, last
		// message). The main window re-pushes on request (pet:state-request).
		// Was previously unreachable dead code: the arrow's `return` above
		// (subscription teardown) returned from the effect before this ran.
		void bridge?.requestPetState?.();
		return off;
	}, []);

	// Panel toggle from the pet window (single click) / pet context menu.
	useEffect(() => {
		return bridge?.onPetPanelToggle?.(() => {
			if (panelOpen) {
				setPanelLeaving(true);
				window.setTimeout(() => {
					setPanelLeaving(false);
					setPanelOpen(false);
					void bridge?.petSetPanel?.(false);
					setApprovals([]);
				}, 140);
			} else {
				setPanelOpen(true);
				void bridge?.petSetPanel?.(true);
			}
		});
	}, [panelOpen]);

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

	// Report the content size whenever it changes — the main process keeps
	// the OS window exactly content-sized (a glass card, not a rectangle).
	// The bubbles/panel are absolutely positioned, so the root box is
	// 0×0 — measure the union of the content elements instead.
	useEffect(() => {
		if (!bridge?.setBubbleSize) return;
		// The OS window is sized from this report; pad it so the glass
		// edge wraps the content instead of clipping it (the elements
		// carry their own margin — the report is the element box, not
		// the margin box; without padding the window equals the panel
		// width and the right/bottom edge gets cut). 24px covers the
		// bubble/panel box-shadows (0 4px 20px / 0 10px 30px) and the
		// dismiss/stack-chip overhangs (-7px/-9px) so the shadow is never
		// clipped at the transparent window edge (must match the
		// .pet-bubble-window margin in pet-window.css).
		const PAD = 24;
		const report = (): void => {
			// Bounding-box accumulators over the content elements. The
			// self-referential `union = { left: Math.min(union?.left ?? …) }`
			// merge trips tsgo's flow analysis into never; plain min/max
			// over initialized numbers sidesteps the workaround entirely
			// and reads as a bounding box.
			let left = Infinity;
			let top = Infinity;
			let right = -Infinity;
			let bottom = -Infinity;
			for (const el of document.querySelectorAll<HTMLElement>(".pet-bubbles, .pet-panel")) {
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				// Entrance/leaving keyframes scale the box; getBoundingClientRect
				// includes the transform, so a mid-animation report would size
				// the window to the animating (shrunk) box and the window would
				// pop once the animation settles. The layout box (offset*)
				// ignores transforms — use it while the element animates; the
				// animationend re-report below settles the final size.
				let w = r.width;
				let h = r.height;
				const animating =
					typeof el.getAnimations === "function" && el.getAnimations().some(a => a.playState === "running");
				if (animating) {
					w = el.offsetWidth;
					h = el.offsetHeight;
				}
				left = Math.min(left, r.left);
				top = Math.min(top, r.top);
				right = Math.max(right, r.left + w);
				bottom = Math.max(bottom, r.top + h);
			}
			if (left !== Infinity) {
				void bridge.setBubbleSize?.({
					width: Math.ceil(right - left) + PAD * 2,
					height: Math.ceil(bottom - top) + PAD * 2,
				});
			} else {
				void bridge.setBubbleSize?.(null);
			}
			// Entrance/leaving animations transform (scale/translate) the
			// box, and transforms do NOT fire ResizeObserver — a mid-
			// animation report would be the last word and the window would
			// stay too small, clipping the settled content. Re-report when
			// the animation ends.
			for (const el of document.querySelectorAll<HTMLElement>(".pet-panel, .pet-bubbles")) {
				el.addEventListener("animationend", report, { once: true });
			}
			// Keep the RO watching the LIVE content set: this effect runs
			// before any bubble exists, so the mount-time observe list is
			// empty — bubbles/panel arriving later would never re-report
			// as they grow (typewriter, new bubbles). observe() is
			// idempotent, so re-observing every report is cheap.
			for (const el of document.querySelectorAll<HTMLElement>(".pet-bubbles, .pet-panel")) {
				ro.observe(el);
			}
		};
		const ro = new ResizeObserver(report);
		for (const el of document.querySelectorAll(".pet-bubbles, .pet-panel")) ro.observe(el);
		report();
		// Delayed re-reports: typewriter growth / panel entrance change the
		// box after mount; the mutation observer catches newly mounted
		// content elements (bubbles appear/disappear, stack expands) and
		// characterData picks up the typewriter's per-tick text growth.
		const t = window.setTimeout(report, 300);
		const mo = new MutationObserver(report);
		const root = document.getElementById("root");
		if (root) mo.observe(root, { childList: true, subtree: true, characterData: true });
		return () => {
			ro.disconnect();
			mo.disconnect();
			window.clearTimeout(t);
		};
	}, []);

	// Collapsed ⇄ expanded with a size morph: capture the old size,
	// swap the view (renderer locks the container to `from` via the
	// inline style), then measure the target size and transition. The
	// ResizeObserver reports every frame of the transition, so the window
	// itself grows/shrinks with the morph — no report short-circuiting.
	const switchStack = (next: boolean): void => {
		if (next === stackExpanded) return;
		const r = stackRef.current?.getBoundingClientRect();
		setStackExpanded(next);
		setStackMorph(r ? { from: { width: r.width, height: r.height } } : null);
	};

	useEffect(() => {
		if (!stackMorph) return;
		const el = stackRef.current;
		if (!el) return;
		// The renderer locks the container to `from` (inline size).
		// Measuring needs the TRUE content size: scrollHeight bottoms
		// out at the locked client height and the locked width masks the
		// max-content target (collapse direction would read `from` itself
		// and skip the morph), so lift the lock, measure, then re-lock —
		// same frame, no paint in between. Lift with "" (drop the inline
		// declaration), NOT "auto": on a block box auto resolves to the
		// containing block's width, so the .pet-bubble-window rule's
		// `width: max-content` (which auto would override) never applies
		// and the measured target degenerates to the window width.
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
		// past the target and settles back, and the ResizeObserver-driven
		// window follows, giving the iOS Notification-Center bounce.
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
	// the window is still bubble-stack-sized (≈140px): an immediate entrance
	// animation would paint the ~310px panel clipped to the old window —
	// left-aligned content shows its right half first, then the left half
	// pops in when the window resizes. The window resize event is the sync
	// point: only then does the panel get its entrance animation (the OS
	// window resize is content-driven and one IPC round-trip behind the
	// React commit). 120ms fallback covers a window that was already panel-
	// sized or a missed event.
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

	const togglePanel = (): void => {
		if (panelOpen) {
			setPanelLeaving(true);
			window.setTimeout(() => {
				setPanelLeaving(false);
				setPanelOpen(false);
				void bridge?.petSetPanel?.(false);
				setApprovals([]);
			}, 140);
		} else {
			setPanelOpen(true);
			void bridge?.petSetPanel?.(true);
			// Fresh state on every open — idle sessions push state only on
			// change, so an old panel would show a stale title/message.
			void bridge?.requestPetState?.();
		}
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

	const show = panelOpen || bubbles.length > 0;

	return (
		<div className="pet-bubble-window" ref={rootRef}>
			{panelOpen ? (
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
								onClick={togglePanel}
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
										activeSession.messages.map((m, i) => (
											<div key={i} className={`pet-panel__msg pet-panel__msg--${m.role}`}>
												{m.text}
											</div>
										))
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
			) : (
				bubbles.length > 0 &&
				// iOS Notification-Center stack: collapsed shows only the
				// newest bubble (count chip when more pending); expanded
				// shows the full list (scrolls within the window).
				(stackExpanded ? (
					<div
						ref={stackRef}
						className={`pet-bubbles pet-bubbles--expanded${stackMorph ? " pet-bubbles--morphing" : ""}`}
						style={
							stackMorph
								? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` }
								: undefined
						}
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
									// Completion/error bubbles carry their session:
									// click opens it in the main window (that's the
									// "read" action) and dismisses them. Plain
									// notifications just focus the main window.
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
							</div>
						))}
					</div>
				) : (
					<div
						ref={stackRef}
						className={`pet-bubbles pet-bubbles--stacked${stackMorph ? ` pet-bubbles--morphing${!stackExpanded ? " pet-bubbles--shrinking" : ""}` : ""}`}
						style={
							stackMorph
								? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` }
								: undefined
						}
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
									{more > 0 && (
										<span className="pet-bubble__more">{t("pet bubbles more", { count: more })}</span>
									)}
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
								</div>
							);
						})()}
					</div>
				))
			)}
			{!show && <div className="pet-bubble-window__empty" aria-hidden />}
		</div>
	);
}

// Unified tooltip layer for this window too (bubble controls have titles).
initTooltips();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<BubbleApp />
	</StrictMode>,
);
