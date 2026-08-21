/**
 * Pet window entry (pet.html) — the floating desktop companion (伙伴),
 * now in its OWN window, split from the bubbles/panel (双窗口):
 *
 *   - pet window (pet.html, THIS file): the active pet (builtin SVG or
 *     Petdex spritesheet) with a mood driven by the main window's session
 *     store, unread badge, and a drag/hover/dock gesture surface. Fully
 *     transparent, click-through outside the sprite — the pet floats on
 *     the desktop.
 *   - bubble window (bubble.html): activity bubbles + interaction panel
 *     on a real vibrancy glass surface (bubble-main.tsx).
 *
 * Pointer handling:
 *   - drag beyond 8px moves the OS window (pet-drag delta IPC)
 *   - a click (below threshold) toggles the interaction panel — the panel
 *     lives in the BUBBLE window, so a click routes through the main
 *     process (pet-toggle-panel → bubble:panel-toggle)
 *   - a double-click toggles the main window (visible → minimize)
 *   - hover/dragging switch the petdex sprite to rows 1/2 (BitFun parity);
 *     hover is driven by the MAIN process (it knows when the cursor is in
 *     the interactive hitbox, including when the window is click-through)
 *
 * The bubble/panel data (bubbles, approvals, session state, recent
 * sessions) flows to the bubble window; this window consumes only
 * mood/scale/unread/theme from pet:activity.
 */

import { setLocale, t } from "@musepi/desktop-web";
import { type ReactNode, type PointerEvent as ReactPointerEvent, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initTooltips } from "./lib/tooltips";
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
	movePetWindowByClient?(clientX: number, clientY: number): Promise<unknown>;
	petDragArm?(): Promise<unknown>;
	petDragEnd?(): Promise<unknown>;
	focusMainWindow?(): Promise<unknown>;
	/** Pet double-click → toggle the main window (visible → minimize,
	 *  hidden/minimized → show + focus). */
	toggleMainWindow?(): Promise<unknown>;
	/** Pet right-click → native context menu (main process). */
	petContextMenu?(): Promise<unknown>;
	/** Single click → toggle the bubble window's interaction panel. */
	toggleBubblePanel?(): Promise<unknown>;
	setPetHitbox?(rect: { x: number; y: number; width: number; height: number } | null): Promise<unknown>;
	/** Sprite-only rect (without the unread badge) — used by the main
	 *  process to align the CHARACTER flush to a screen edge on dock. */
	setPetRect?(rect: { x: number; y: number; width: number; height: number } | null): Promise<unknown>;
	onPetDock?(cb: (side: "left" | "right" | null) => void): () => void;
	/** Unread-badge click → mark every session read (main window owns the
	 *  unread set and pushes bubble dismissals back). */
	petMarkAllRead?(): Promise<unknown>;
}

const DRAG_THRESHOLD_PX = 8;
/** Max gap between two clicks on the pet for a double-click (→ toggle the
 *  main window). Single clicks defer their panel toggle by this window so
 *  a double click never flashes the panel open/closed. */
const DOUBLE_CLICK_MS = 300;

function PetApp(): ReactNode {
	const { enabled, pet } = usePet();
	const [mood, setMood] = useState<PetMood>("rest");
	const [hovering, setHovering] = useState(false);
	const [dragging, setDragging] = useState(false);
	// Ambient idle choreography: while the pet sits calm at rest, briefly swap
	// to a livelier idle row (thinking / lingering) so it has a life of its own
	// instead of breathing in place forever (open-design `pet-overlay` parity).
	const [ambientMood, setAmbientMood] = useState<PetMood | null>(null);
	// Horizontal drag direction: the dragging row's frames are a fixed-
	// direction walk cycle, so moving the other way must mirror them
	// (BitFun doesn't — it reads as running backwards on rightward drags).
	const [flip, setFlip] = useState(false);
	const [sizeScale, setSizeScale] = useState<number>(() => petScale());
	const [dockSide, setDockSide] = useState<"left" | "right" | null>(null);
	const [unreadCount, setUnreadCount] = useState(0);
	const bridge = (window as unknown as { electronAPI?: PetBridge }).electronAPI;
	const bumpRef = useRef<HTMLDivElement>(null);
	// RAF-coalesced drag move: pointermove can fire 120Hz+, and firing one
	// IPC per event queues up behind the main process's setPosition — the
	// window then lags the cursor and the lag noise shows up as jitter.
	// One move per animation frame with the LATEST client point (Clawd's
	// queueDragMove pattern) keeps the window glued to the cursor.
	const dragMoveRafRef = useRef<number | null>(null);
	const pendingMoveRef = useRef<{ clientX: number; clientY: number } | null>(null);
	// Click-vs-double-click discrimination: the first click's panel toggle
	// is deferred; if a second click lands within DOUBLE_CLICK_MS it is
	// cancelled and the main window is toggled instead.
	const lastClickRef = useRef(0);
	const clickTimerRef = useRef<number | null>(null);

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
		/** True once travel exceeded the drag threshold. Survives
		 *  resetDrag (which zeroes lastX/lastY): a drag interrupted by
		 *  lostpointercapture/blur must still count as a drag, not a
		 *  click — otherwise moving the pet pops the panel open. */
		moved: boolean;
	}>({
		startX: 0,
		startY: 0,
		lastX: 0,
		lastY: 0,
		dragging: false,
		pressed: false,
		dirAcc: 0,
		moved: false,
	});

	useEffect(() => {
		if (!bridge?.onPetActivity) return;
		return bridge.onPetActivity?.(payload => {
			if (payload.mood) setMood(payload.mood);
			if (typeof payload.scale === "number" && payload.scale > 0) setSizeScale(payload.scale);
			if (typeof payload.unreadCount === "number") setUnreadCount(payload.unreadCount);
			if (typeof payload.locale === "string") setLocale(payload.locale);
			// Main-window scheme push (the reliable path — storage events
			// don't fire cross-window under file://).
			if (payload.theme === "light" || payload.theme === "dark") {
				document.documentElement.dataset.theme = payload.theme;
				document.documentElement.dataset.colorScheme = payload.theme;
			}
		});
		// bridge is a window-level constant (preload) — subscribe once.
	}, []);

	// Hover state comes from the main process: it alone knows when the
	// cursor is inside the interactive hitbox (the window is click-through
	// outside it, so pointer events would otherwise be lost on exit).
	useEffect(() => {
		if (!bridge?.onPetHover) return;
		return bridge.onPetHover?.(setHovering);
	}, []);

	// Dock side after an edge snap (settings → 宠物 → 挂靠左右侧): the
	// main process pushes it; the edge highlight bar follows.
	useEffect(() => {
		if (!bridge?.onPetDock) return;
		return bridge.onPetDock?.(setDockSide);
	}, []);

	// Ambient idle choreography scheduler (open-design `pet-overlay` parity).
	// While the pet rests calm and nothing is hovering/dragging, occasionally
	// play a livelier idle row (thinking / lingering) for a few seconds, then
	// return to the baseline rest for a longer, randomised rest window. Both
	// windows are randomised so the rhythm never feels mechanical; the rest
	// window is deliberately generous so the pet reads calm rather than fidgety.
	// Any user gesture (hover / drag) cancels the beat via cleanup.
	useEffect(() => {
		if (mood !== "rest" || hovering || dragging) {
			setAmbientMood(null);
			return;
		}
		if (pet.kind !== "petdex") return;
		const AMBIENT_PLAY_MIN_MS = 1800;
		const AMBIENT_PLAY_VARIANCE_MS = 1200;
		const AMBIENT_REST_MIN_MS = 9000;
		const AMBIENT_REST_VARIANCE_MS = 9000;
		const AMBIENT_INITIAL_DELAY_MIN_MS = 4000;
		const AMBIENT_INITIAL_DELAY_VARIANCE_MS = 4000;
		// Idle-friendly rows that read as "considering / lingering" rather than
		// task work — swapped in for a beat then released back to rest.
		const AMBIENT_MOODS: PetMood[] = ["waiting", "analyzing"];
		let playTimer: number | undefined;
		let restTimer: number | undefined;

		const playBeat = (): void => {
			setAmbientMood(AMBIENT_MOODS[Math.floor(Math.random() * AMBIENT_MOODS.length)] ?? "waiting");
			const playMs =
				AMBIENT_PLAY_MIN_MS + Math.floor(Math.random() * AMBIENT_PLAY_VARIANCE_MS);
			playTimer = window.setTimeout(() => {
				setAmbientMood(null);
				const restMs =
					AMBIENT_REST_MIN_MS + Math.floor(Math.random() * AMBIENT_REST_VARIANCE_MS);
				restTimer = window.setTimeout(playBeat, restMs);
			}, playMs);
		};

		const initialDelay =
			AMBIENT_INITIAL_DELAY_MIN_MS + Math.floor(Math.random() * AMBIENT_INITIAL_DELAY_VARIANCE_MS);
		restTimer = window.setTimeout(playBeat, initialDelay);

		return () => {
			if (playTimer !== undefined) window.clearTimeout(playTimer);
			if (restTimer !== undefined) window.clearTimeout(restTimer);
			setAmbientMood(null);
		};
	}, [mood, hovering, dragging, pet]);

	// Light/dark scheme: mirror the main app's scheme (local pref +
	// system default); the main window's petActivity push overrides it.
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

	// Report the interactive rect (pet + unread badge) whenever the layout
	// changes. The MAIN process resizes this window's click-through state;
	// re-measure on window resize too.
	useEffect(() => {
		if (!bridge?.setPetHitbox) return;
		const report = (): void => {
			const pet = document.querySelector<HTMLElement>(".pet-window__pet");
			const badge = document.querySelector<HTMLElement>(".pet-window__badge");
			// Sprite-only rect: dock alignment snaps the CHARACTER flush to
			// the edge, not the (larger) window or the hitbox's badge bump.
			let petRect: { x: number; y: number; width: number; height: number } | null = null;
			if (pet) {
				const r = pet.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) {
					petRect = {
						x: Math.round(r.left),
						y: Math.round(r.top),
						width: Math.round(r.width),
						height: Math.round(r.height),
					};
				}
			}
			void bridge.setPetRect?.(petRect);
			let rect: { x: number; y: number; width: number; height: number } | null = null;
			const union: Record<string, number> = {};
			for (const el of [pet, badge]) {
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
	}, []);

	// Mood transition micro-bump (BitFun's stage-bump): replay the one-shot
	// on the wrapper without remounting the sprite (which would restart the
	// frame cycle).
	useEffect(() => {
		const el = bumpRef.current;
		if (!el) return;
		el.classList.remove("gui-pet-bump");
		void el.offsetWidth; // force reflow so the class re-triggers
		el.classList.add("gui-pet-bump");
	}, []);

	const resetDrag = (): void => {
		if (!dragRef.current.pressed) return;
		dragRef.current.pressed = false;
		dragRef.current.dragging = false;
		dragMoveRafRef.current = null;
		pendingMoveRef.current = null;
		if (dragging) {
			setDragging(false);
		}
		// Always disarm: a drag interrupted by lostpointercapture (e.g. the
		// click-through flip on Windows) must still release the main-process
		// arm, or the pet window stays interactive forever.
		void bridge?.petDragEnd?.();
	};

	// Window blur (focus lost mid-drag — e.g. clicking another app while
	// holding the pet): teardown identical to lostpointercapture, or the
	// main-process arm stays locked and the pointer stream is dropped.
	// Same teardown path as the other interrupters, and `moved` survives
	// resetDrag so an interrupted drag still counts as a drag, not a click.
	const resetDragRef = useRef(resetDrag);
	resetDragRef.current = resetDrag;
	useEffect(() => {
		const onBlur = (): void => resetDragRef.current();
		window.addEventListener("blur", onBlur);
		return () => window.removeEventListener("blur", onBlur);
	}, []);

	const onPointerDown = (e: ReactPointerEvent): void => {
		// Right-click opens the native context menu (onContextMenu) — it is
		// not a drag/click gesture and must not arm one (a right-click
		// would otherwise pop the panel via the deferred click timer).
		if (e.button !== 0) return;
		// A new gesture starts: any deferred single-click toggle from the
		// previous click is void — otherwise a click followed within the
		// double-click window by a drag would fire togglePanel() mid-drag.
		if (clickTimerRef.current !== null) {
			window.clearTimeout(clickTimerRef.current);
			clickTimerRef.current = null;
		}
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
		s.moved = false;
		e.currentTarget.setPointerCapture(e.pointerId);
		// Arm the click-through gate: from this point until pointerup the
		// window must stay interactive (the 120ms poll would otherwise flip
		// ignore and drop the pointer stream between down and first move).
		void bridge?.petDragArm?.();
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
			s.moved = true;
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

	const onPointerUp = (e: ReactPointerEvent): void => {
		// Right button is the context menu gesture, never a click — without
		// this gate the pointerup falls through to the click/double-click
		// path and pops the bubble panel alongside the native menu.
		if (e.button !== 0) return;
		const s = dragRef.current;
		s.pressed = false;
		s.dragging = false;
		if (s.moved) {
			// A completed drag is a drag, never a click — the panel must
			// not pop after moving the pet.
			s.moved = false;
			setDragging(false);
			void bridge?.petDragEnd?.();
			return;
		}
		// Click vs double-click: two clicks within DOUBLE_CLICK_MS toggle
		// the main window; one click toggles the bubble panel.
		const now = Date.now();
		if (now - lastClickRef.current <= DOUBLE_CLICK_MS) {
			if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
			clickTimerRef.current = null;
			lastClickRef.current = 0;
			void bridge?.toggleMainWindow?.();
			// Disarm (no drag happened — pointer just went down and up).
			void bridge?.petDragEnd?.();
			return;
		}
		lastClickRef.current = now;
		// Defer the single-click panel toggle by the double-click window so
		// a double click never flashes the panel open then closed.
		clickTimerRef.current = window.setTimeout(() => {
			clickTimerRef.current = null;
			void bridge?.toggleBubblePanel?.();
			// Disarm after the click's pointer stream ends too.
			void bridge?.petDragEnd?.();
		}, DOUBLE_CLICK_MS + 20);
	};

	if (!enabled) return null;

	const displayMood = dragging ? "dragging" : hovering ? "hover" : ambientMood ?? mood;
	// Docked to the left edge the pet faces OUT of the screen (the walk
	// frames face left) — mirror it so it always faces the workspace.
	const mirrored = flip || dockSide === "left";

	return (
		<div className={`pet-window${dockSide ? ` pet-window--dock-${dockSide}` : ""}`}>
			{/* Stage: centers the sprite AND anchors the unread badge to it —
			 * a badge anchored to the WINDOW (top/right) floats ~70px right
			 * of the centered ~104px sprite in the 320px window. The stage
			 * shrink-wraps the sprite, so the badge's absolute top/right
			 * tracks the sprite's top-right corner regardless of the pet's
			 * frame size or the user's scale. pointer-events: none keeps
			 * only the pet interactive. */}
			<div className="pet-window__stage">
				{unreadCount > 0 && (
					<button
						type="button"
						className="pet-window__badge"
						role="status"
						aria-label={t("mark all read")}
						title={t("mark all read")}
						onClick={() => void bridge?.petMarkAllRead?.()}
					>
						{unreadCount > 99 ? "99+" : unreadCount}
					</button>
				)}
				<div
					ref={bumpRef}
					className="pet-window__pet"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={resetDrag}
					onLostPointerCapture={resetDrag}
					// Hover is driven by the MAIN process (pet:hover): the
					// renderer's own pointerenter/leave fire spuriously on
					// click-through flips (the window stops/restarts
					// receiving mouse events), fighting the main push and
					// flickering the hover mood row. The main poll knows
					// the true cursor-vs-hitbox state.
					onContextMenu={e => {
						e.preventDefault();
						void bridge?.petContextMenu?.();
					}}
				>
					<div className={`pet-window__pet-flip${mirrored ? " pet-window__pet-flip--mirror" : ""}`}>
						<PetSprite
							mood={displayMood}
							pet={pet}
							size={104}
							scale={sizeScale}
							frozen={displayMood === "hover"}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}

// Unified tooltip layer for this window too (pet controls have titles).
initTooltips();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<PetApp />
	</StrictMode>,
);
