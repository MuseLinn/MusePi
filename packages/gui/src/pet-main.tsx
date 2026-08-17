/**
 * Pet window entry (pet.html) — the floating desktop companion (伙伴).
 *
 * A frameless transparent always-on-top Electron window that renders the
 * active pet (builtin SVG or Petdex spritesheet) with a mood driven by the
 * main window's session store, plus activity bubbles (completed / error /
 * question / subtask) pushed over IPC.
 *
 * Interaction panel (click the pet to toggle): a live task summary (the
 * agent's current tool + last message), the pending tool-approval card
 * (批准/拒绝 answered through the main window), and a quick-reply box that
 * steers the active session. The panel grows the window (pet-set-panel)
 * so it has room; the compact 320×290 shell is restored on collapse.
 *
 * Pointer handling:
 *   - drag beyond 8px moves the OS window (pet-drag delta IPC)
 *   - a click (below threshold) toggles the interaction panel
 *   - hover/dragging switch the petdex sprite to rows 1/2 (BitFun parity);
 *     hover is driven by the MAIN process (it knows when the cursor is in
 *     the interactive hitbox, including when the window is click-through)
 *
 * Bubbles form a small stack (max 2, newest on top) with a typewriter
 * reveal per bubble, a dismiss ×, and an 8s auto-dismiss. While the panel
 * is open the bubbles are hidden (the panel shows the same information).
 */

import { setLocale, t } from "@musepi/collab-web";
import { type ReactNode, type PointerEvent as ReactPointerEvent, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PetSprite, usePet } from "./components/PetSprite";
import { type PetActivity, type PetMood, petScale } from "./lib/pet";

/** Horizontal travel (px) that must accumulate before the pet mirrors its
 *  walk frames — absorbs the ±1–2px per-move jitter of real mouse deltas. */
const DIR_FLIP_THRESHOLD_PX = 5;

// The pet window needs the full pet style set (.gui-pet-svg-*, mood
// keyframes, .gui-petdex-sprite) — those live in gui.css alongside the app
// tokens. Import order matters: gui.css AFTER pet-window.css so the tokens
// :root (dark default) wins; the pet window never sets data-theme.
import "./styles/pet-window.css";
import "./styles/gui.css";

interface PetBridge {
	onPetActivity?(cb: (payload: PetActivity) => void): () => void;
	onPetHover?(cb: (hovering: boolean) => void): () => void;
	requestPetState?(): Promise<unknown>;
	movePetWindowByClient?(clientX: number, clientY: number): Promise<unknown>;
	petDragEnd?(): Promise<unknown>;
	focusMainWindow?(): Promise<unknown>;
	setPetHitbox?(rect: { x: number; y: number; width: number; height: number } | null): Promise<unknown>;
	petReply?(text: string, sessionId?: string): Promise<unknown>;
	petApprove?(requestId: string, approved: boolean): Promise<unknown>;
	petSetPanel?(open: boolean): Promise<unknown>;
	onPetDock?(cb: (side: "left" | "right" | null) => void): () => void;
	petOpenSession?(sessionId: string): Promise<unknown>;
	petGetSessionContent?(sessionId: string): Promise<unknown>;
	onPetSessionContent?(
		cb: (payload: {
			sessionId: string;
			messages: Array<{ role: string; text: string }>;
			loaded?: boolean;
		}) => void,
	): () => void;
}

const DRAG_THRESHOLD_PX = 8;

/** Compact relative time for the recent-session rows. */
function relTimeLabel(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return `${Math.floor(diff / 86_400_000)} 天前`;
}
const BUBBLE_MS = 8000;
const MAX_VISIBLE_BUBBLES = 2;

interface Bubble {
	id: number;
	kind: string;
	text: string;
	visible: string;
}

interface PendingApproval {
	requestId: string;
	tool: string;
}

function PetApp(): ReactNode {
	const { enabled, pet } = usePet();
	const [mood, setMood] = useState<PetMood>("rest");
	const [hovering, setHovering] = useState(false);
	const [dragging, setDragging] = useState(false);
	// Horizontal drag direction: the dragging row's frames are a fixed-
	// direction walk cycle, so moving the other way must mirror them
	// (BitFun doesn't — it reads as running backwards on rightward drags).
	const [flip, setFlip] = useState(false);
	const [bubbles, setBubbles] = useState<Bubble[]>([]);
	const [sizeScale, setSizeScale] = useState<number>(() => petScale());
	// Interaction panel: live task summary + approval card + quick reply.
	const [panelOpen, setPanelOpen] = useState(false);
	const [panelLeaving, setPanelLeaving] = useState(false);
	const [petState, setPetState] = useState<PetActivity["state"] | null>(null);
	const [approvals, setApprovals] = useState<PendingApproval[]>([]);
	const [replyText, setReplyText] = useState("");
	const [sending, setSending] = useState(false);
	const bridge = (window as unknown as { electronAPI?: PetBridge }).electronAPI;
	const bumpRef = useRef<HTMLDivElement>(null);
	// RAF-coalesced drag move: pointermove can fire 120Hz+, and firing one
	// IPC per event queues up behind the main process's setPosition — the
	// window then lags the cursor and the lag noise shows up as jitter.
	// One move per animation frame with the LATEST client point (Clawd's
	// queueDragMove pattern) keeps the window glued to the cursor.
	const dragMoveRafRef = useRef<number | null>(null);
	const pendingMoveRef = useRef<{ clientX: number; clientY: number } | null>(null);

	// Drag state
	const dragRef = useRef<{
		startX: number;
		startY: number;
		lastX: number;
		lastY: number;
		dragging: boolean;
		pressed: boolean;
		/** Accumulated horizontal travel since the last flip — per-move
		 *  deltas jitter ±1–2px, so flipping on raw deltas makes the pet
		 *  stutter left/right mid-drag. Only cross a threshold to flip. */
		dirAcc: number;
	}>({
		startX: 0,
		startY: 0,
		lastX: 0,
		lastY: 0,
		dragging: false,
		pressed: false,
		dirAcc: 0,
	});

	useEffect(() => {
		if (!bridge?.onPetActivity) return;
		return bridge.onPetActivity?.(payload => {			if (payload.mood) setMood(payload.mood);
			if (typeof payload.scale === "number" && payload.scale > 0) setSizeScale(payload.scale);
			if (Array.isArray(payload.recentSessions)) setRecentSessions(payload.recentSessions);
			if (typeof payload.unreadCount === "number") setUnreadCount(payload.unreadCount);
			if (typeof payload.locale === "string") setLocale(payload.locale);
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
					const next = [...prev, { id, kind: bubble.kind, text: bubble.text, visible: "" }];
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
		});
	// bridge is a window-level constant (preload) — subscribe once.
	// biome-ignore lint/correctness/useExhaustiveDependencies: bridge stable
	}, []);

	// Hover state comes from the main process: it alone knows when the
	// cursor is inside the interactive hitbox (the window is click-through
	// outside it, so pointer events would otherwise be lost on exit).
	useEffect(() => {
		if (!bridge?.onPetHover) return;
		return bridge.onPetHover?.(setHovering);
	}, [bridge]);

	// Transcript for the session opened from the recent list (asked via
	// petGetSessionContent; the main-window renderer answers).
	useEffect(() => {
		if (!bridge?.onPetSessionContent) return;
		return bridge.onPetSessionContent?.(payload => {
			setActiveSession(prev =>
				prev && prev.id === payload.sessionId
					? { ...prev, messages: payload.messages, loaded: payload.loaded === true }
					: prev,
			);
		});
	}, [bridge]);

	// Dock side after an edge snap (settings → 宠物 → 挂靠左右侧): the
	// main process pushes it; the edge highlight bar follows.
	const [dockSide, setDockSide] = useState<"left" | "right" | null>(null);
	// Recent-session list + unread badge pushed from the main window.
	const [recentSessions, setRecentSessions] = useState<{ id: string; label: string; timestamp: number }[]>([]);
	/** Panel is showing one session's transcript instead of the list. */
	const [activeSession, setActiveSession] = useState<{
		id: string;
		label: string;
		messages: Array<{ role: string; text: string }>;
		loaded: boolean;
	} | null>(null);
	const [unreadCount, setUnreadCount] = useState(0);
	useEffect(() => {
		if (!bridge?.onPetDock) return;
		return bridge.onPetDock?.(setDockSide);
	}, [bridge]);

	// The panel spans from the window top down to just above the pet —
	// measure the pet rect (size varies with the scale slider) and set the
	// CSS var so no dead blank shows between panel and pet.
	useEffect(() => {
		if (!panelOpen) return;
		const petEl = document.querySelector<HTMLElement>(".pet-window__pet");
		if (!petEl) return;
		const r = petEl.getBoundingClientRect();
		const gap = Math.max(10, Math.round(window.innerHeight - r.top + 12));
		document.documentElement.style.setProperty("--pet-panel-bottom", `${gap}px`);
	}, [panelOpen, sizeScale, petState]);

	// Ask for a fresh snapshot when the window (re)appears.
	useEffect(() => {
		void bridge?.requestPetState?.();
	}, [bridge]);

	// Report the interactive rect (pet + bubbles + panel) whenever the
	// layout changes (bubble appears/disappears, pet size, panel open).
	// The MAIN process resizes this window on panel toggle (pet-set-panel);
	// after the shrink the pet's position shifts and the old rect would
	// leave the pet click-through (cursor in the pet but outside the stale
	// hitbox) — re-measure on window resize too.
	useEffect(() => {
		if (!bridge?.setPetHitbox) return;
		const report = (): void => {
			const pet = document.querySelector<HTMLElement>(".pet-window__pet");
			// .pet-bubble__dismiss overhangs the bubble box by 7px (top/-7
			// right/-7) — including it keeps the × fully clickable instead
			// of leaving a dead strip outside the union.
			const bubbles = document.querySelectorAll<HTMLElement>(".pet-bubble, .pet-bubble__dismiss");
			const panel = document.querySelector<HTMLElement>(".pet-panel");
			let rect: { x: number; y: number; width: number; height: number } | null = null;
			const union: Record<string, number> = {};
			for (const el of panelOpen ? [panel, pet] : [pet, ...bubbles]) {
				if (!el) continue;
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				union.left = Math.min(union.left ?? Infinity, r.left);
				union.top = Math.min(union.top ?? Infinity, r.top);
				union.right = Math.max(union.right ?? -Infinity, r.right);
				union.bottom = Math.max(union.bottom ?? -Infinity, r.bottom);
			}
			if (union.left !== undefined) {
				rect = {
					x: Math.round(union.left),
					y: Math.round(union.top),
					width: Math.round(union.right - union.left),
					height: Math.round(union.bottom - union.top),
				};
			}
			void bridge.setPetHitbox?.(rect);
		};
		report();
		window.addEventListener("resize", report);
		return () => window.removeEventListener("resize", report);
	}, [bridge, bubbles, panelOpen]);

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

	// Mood transition micro-bump (BitFun's stage-bump): replay the one-shot
	// on the wrapper without remounting the sprite (which would restart the
	// frame cycle).
	useEffect(() => {
		const el = bumpRef.current;
		if (!el) return;
		el.classList.remove("gui-pet-bump");
		void el.offsetWidth; // force reflow so the class re-triggers
		el.classList.add("gui-pet-bump");
	}, [mood, hovering, dragging]);

	if (!enabled) return null;

	const displayMood = dragging ? "dragging" : hovering ? "hover" : mood;

	const togglePanel = (): void => {
		if (panelOpen) {
			// Two-phase collapse: play the 140ms fade/blur out, then unmount
			// and shrink the window (the pet stays put — main restores the
			// pre-panel position).
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

	const onPointerDown = (e: ReactPointerEvent): void => {
		// Drag uses clientX/Y (window-relative logical pixels — unit-stable,
		// unlike screenX which flips between logical/physical across
		// down/move on macOS Retina). The main process converts to screen
		// coordinates with the window position; window moves cancel out.
		const s = dragRef.current;
		s.startX = e.clientX;
		s.startY = e.clientY;
		s.lastX = e.clientX;
		s.lastY = e.clientY;
		s.dragging = false;
		s.pressed = true;
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const queueDragMove = (clientX: number, clientY: number): void => {
		pendingMoveRef.current = { clientX, clientY };
		if (dragMoveRafRef.current !== null) return;
		dragMoveRafRef.current = requestAnimationFrame(() => {
			dragMoveRafRef.current = null;
			const p = pendingMoveRef.current;
			pendingMoveRef.current = null;
			if (!p || !dragRef.current.dragging) return;
			void bridge?.movePetWindowByClient?.(p.clientX, p.clientY);
		});
	};

	const onPointerMove = (e: ReactPointerEvent): void => {
		// Ignore hover moves entirely — the window must never move unless a
		// pointer is actually down. Without this gate, a plain click (down
		// then up) leaves `startX` stale and any later hover move >8px
		// would arm `dragging` and drag the window.
		if (!dragRef.current.pressed) return;
		const s = dragRef.current;
		const dx = e.clientX - s.startX;
		const dy = e.clientY - s.startY;
		if (!s.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
			s.dragging = true;
			setDragging(true);
		}
		if (s.dragging) {
			// Mirror the walk frames to match travel direction. Deltas are
			// accumulated and flipped only past a threshold: raw per-move
			// deltas jitter ±1–2px, which would stutter the pet left/right.
			// The frames are a leftward walk cycle — rightward travel
			// (accumulated positive) needs mirroring.
			s.dirAcc += e.clientX - s.lastX;
			if (s.dirAcc > DIR_FLIP_THRESHOLD_PX) {
				setFlip(true);
				s.dirAcc = 0;
			} else if (s.dirAcc < -DIR_FLIP_THRESHOLD_PX) {
				setFlip(false);
				s.dirAcc = 0;
			}
			queueDragMove(e.clientX, e.clientY);
			s.lastX = e.clientX;
			s.lastY = e.clientY;
		}
	};
	const resetDrag = (): void => {
		// Idempotent (Clawd's stopDrag guard): pointerup, pointercancel,
		// lostpointercapture and window blur all funnel here, and any of
		// them may fire twice (e.g. up after blur).
		if (!dragRef.current.pressed && !dragRef.current.dragging) return;
		if (dragMoveRafRef.current !== null) {
			cancelAnimationFrame(dragMoveRafRef.current);
			dragMoveRafRef.current = null;
		}
		pendingMoveRef.current = null;
		const s = dragRef.current;
		s.pressed = false;
		s.dragging = false;
		s.lastX = s.startX;
		s.lastY = s.startY;
		s.dirAcc = 0;
		setDragging(false);
		setFlip(false);
		// Every path that ends the pointer gesture (up AND cancel) must
		// clear the main-process drag anchor — a stale petDragLast makes
		// the next drag's first move jump the window by the old delta.
		void bridge?.petDragEnd?.();
	};
	const onPointerUp = (): void => {
		const wasDragging = dragRef.current.dragging;
		resetDrag();
		if (!wasDragging) {
			// Click on the pet toggles the interaction panel (focusing the
			// main window is no longer needed — the panel is interactive).
			togglePanel();
		}
	};

	return (
		<div className={`pet-window${dockSide ? ` pet-window--dock-${dockSide}` : ""}`}>
			{bubbles.length > 0 && !panelOpen && (
				<div className="pet-bubbles" aria-live="polite">
					{[...bubbles].reverse().map(b => (
						<div key={b.id} className={`pet-bubble pet-bubble--${b.kind}`}>
							<button
								type="button"
								className="pet-bubble__dismiss"
								aria-label="dismiss"
								onClick={() => setBubbles(prev => prev.filter(x => x.id !== b.id))}
							>
								×
							</button>
							<div className="pet-bubble__text">{b.visible}</div>
						</div>
					))}
				</div>
			)}
			{panelOpen && (
				<div className={`pet-panel${panelLeaving ? " pet-panel--leaving" : ""}`}>
					<div className="pet-panel__head">
						<span className="pet-panel__title" title={petState?.sessionTitle ?? undefined}>
							{petState?.sessionTitle ? petState.sessionTitle : t("MusePi")}
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
					<div className="pet-panel__body">
						{activeSession ? (
							<div className="pet-panel__session">
								<button
									type="button"
									className="pet-panel__session-back"
									onClick={() => setActiveSession(null)}
								>
									← {t("back")}
								</button>
								<div className="pet-panel__session-title" title={activeSession.label}>
									{activeSession.label}
								</div>
								<div className="pet-panel__session-msgs">
									{!activeSession.loaded ? (
										<div className="pet-panel__session-empty">{t("loading…")}</div>
									) : activeSession.messages.length === 0 ? (
										<div className="pet-panel__session-empty">{t("no messages yet")}</div>
									) : (
										activeSession.messages.map((m, i) => (
											<div
												key={i}
												className={`pet-panel__msg pet-panel__msg--${m.role}`}
											>
												{m.text}
											</div>
										))
									)}
								</div>
							</div>
						) : (
							<>
						{/* Live task summary */}
						<div className="pet-panel__status">
							<div className="pet-panel__status-dot" aria-hidden="true" />
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
						{petState?.lastMessage && (
							<div className="pet-panel__message">{petState.lastMessage}</div>
						)}
						{/* Recent sessions (最近活跃会话): click to open in the
						 * main window — same source as the sidebar tree. */}
						{recentSessions.length > 0 && (
							<div className="pet-panel__recent">
								<div className="pet-panel__recent-head">{t("recent sessions")}</div>
								{recentSessions.slice(0, 5).map(rs => (
									<button
										key={rs.id}
										type="button"
										className="pet-panel__recent-row"
										title={rs.label}
										onClick={() => {
											// Enter the session transcript inside the
											// panel; the main window keeps its state.
											setActiveSession({
												id: rs.id,
												label: rs.label || t("session"),
												messages: [],
												loaded: false,
											});
											void bridge?.petGetSessionContent?.(rs.id);
										}}
									>
										<span className="pet-panel__recent-label">{rs.label || t("session")}</span>
										<span className="pet-panel__recent-time">{relTimeLabel(rs.timestamp)}</span>
									</button>
								))}
							</div>
						)}
						{/* Pending approvals */}
						{approvals.length > 0 && (
							<div className="pet-panel__approvals">
								{approvals.map(a => (
									<div key={a.requestId} className="pet-panel__approval">
										<div className="pet-panel__approval-tool">{t("pet approval · {tool}", { tool: a.tool })}</div>
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
						{/* Quick reply — always available: with an active session it
						 * steers that session; without one it creates a new
						 * session with the text as the first message (same as
						 * the welcome composer). In the transcript view it
						 * replies to the session shown. */}
							</>
						)}
						<div className="pet-panel__reply">
							<input
								className="pet-panel__input"
								value={replyText}
								placeholder={
									activeSession
										? t("pet reply placeholder")
										: petState
											? t("pet reply placeholder")
											: t("pet new message placeholder")
								}
								onChange={e => setReplyText(e.target.value)}
								onKeyDown={e => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										e.preventDefault();
										sendReply();
									}
								}}
							/>
							<button
								type="button"
								className="pet-panel__send"
								disabled={!replyText.trim() || sending}
								onClick={sendReply}
							>
								{sending ? "…" : "↑"}
							</button>
						</div>
					</div>
				</div>
			)}
			{unreadCount > 0 && (
				<div className="pet-window__badge" role="status" aria-label={t("unread sessions")}>
					{unreadCount > 99 ? "99+" : unreadCount}
				</div>
			)}
			<div
				ref={bumpRef}
				className="pet-window__pet"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={resetDrag}
				onLostPointerCapture={resetDrag}
				onPointerEnter={() => setHovering(true)}
				onPointerLeave={() => setHovering(false)}
			>
				<div className={`pet-window__pet-flip${flip ? " pet-window__pet-flip--mirror" : ""}`}>
					<PetSprite mood={displayMood} pet={pet} size={104} scale={sizeScale} frozen={displayMood === "hover"} />
				</div>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<PetApp />
	</StrictMode>,
);
