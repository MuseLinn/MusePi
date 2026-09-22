/**
 * Pet window entry (pet.html) — the floating desktop companion (伙伴):
 * the active pet (builtin SVG or Petdex spritesheet) with a mood driven by
 * the main window's session store, unread badge, and a drag/hover/dock
 * gesture surface.
 *
 * The activity bubbles live in a SEPARATE window (bubbles.html,
 * bubbles-main.tsx) since 2026-09-21 — the 2026-09-16 single-window merge
 * made the stack clip at the screen edge and overlap the main window. This
 * window is back to a fixed 320×290 box; the main process pins the bubbles
 * window above the sprite and follows this window on every move.
 *
 * Pointer handling:
 *   - drag beyond 8px moves the OS window (pet-drag-client; the main
 *     process anchors ONCE per drag and tracks the DIP cursor — no
 *     readback, no scale math, exact 1:1 at any scaling)
 *   - a single click greets the pet (interaction animation) and raises the
 *     main client window (2026-09-21: the old single-click panel popup was
 *     deleted — bubbles carry their own hover actions now)
 *   - a double-click plays a random interaction reaction (the full
 *     PET_INTERACTIONS set, dozing excluded — the old show/hide-main-
 *     window shortcut is gone: the window is reached from the taskbar,
 *     and a pet is for petting)
 *   - hover/dragging switch the petdex sprite to rows 1/2 (BitFun parity);
 *     hover is driven by the MAIN process (it knows when the cursor is in
 *     the interactive hitbox, including when the window is click-through)
 *   - 60s idle at rest → sleep state (dimmed + zzz, CSS-only); any
 *     gesture or mood change wakes it
 */

import { setLocale, t } from "@musepi/client-core";
import {
	type CSSProperties,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	StrictMode,
	useEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { type GazeVec, PetSprite, usePet, usePetDecor } from "./components/PetSprite";
import {
	type PetActivity,
	type PetdexPackage,
	type PetInteraction,
	type PetMood,
	type PetState,
	petScale,
	randomPetInteraction,
} from "./lib/pet";
import { applyPetPalette } from "./lib/pet-palette";
import { initTooltips } from "./lib/tooltips";

/** Horizontal travel (px) that must accumulate before the pet mirrors its
 *  walk frames — absorbs the ±1–2px per-move jitter of real mouse deltas. */
const DIR_FLIP_THRESHOLD_PX = 5;

/** Two pokes closer together than this escalate the reaction (startle →
 *  delight). Mirrors the composer pet's combo window so a poke feels the
 *  same wherever the pet lives. */
const POKE_COMBO_MS = 900;

/** How long a transient reaction holds before falling back to the live
 *  mood — pokes, double-click picks and the idle peek/curious beats alike
 *  (they are all gestures; only `dozing` is a scheduler-owned STATE). A
 *  beat longer than the composer's: here the pet is the whole surface, so
 *  the reaction deserves to be seen rather than glimpsed. */
const POKE_HOLD_MS = 1400;

// The pet window needs the full pet style set (.gui-pet-svg-*, mood
// keyframes, .gui-petdex-sprite) — those live in gui.css alongside the app
// tokens. Import order matters: gui.css AFTER pet-window.css so the tokens
// :root (dark default) wins; the pet window never sets data-theme.
import "./styles/pet-window.css";
import "./styles/gui.css";

interface PetBridge {
	onPetActivity?(cb: (payload: PetActivity) => void): () => void;
	onPetHover?(cb: (hovering: boolean) => void): () => void;
	/** Normalized gaze vector (cursor offset from the window centre, clamped
	 *  to ±1) — eye-tracking target, pushed by the click-through poll. */
	onPetGaze?(cb: (gaze: GazeVec) => void): () => void;
	movePetWindowByClient?(clientX: number, clientY: number, screenX: number, screenY: number): Promise<unknown>;
	petDragArm?(): Promise<unknown>;
	petDragEnd?(): Promise<unknown>;
	focusMainWindow?(): Promise<unknown>;
	/** Pet right-click → native context menu (main process). */
	petContextMenu?(): Promise<unknown>;
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
/** Max gap between two clicks on the pet for a double-click (→ a random
 *  interaction reaction). Single clicks defer their action (greet + raise
 *  the main window) by this window so a double click never flashes the
 *  greeting before the random pick takes over. */
const DOUBLE_CLICK_MS = 300;

function PetApp(): ReactNode {
	const { enabled, pet: localPet } = usePet();
	// The main window owns petdex state (its localStorage is unreachable from
	// this window under file://) — it pushes the active pet descriptor on
	// pet:activity; until the first push lands we render the local hook's
	// reading (the same builtin default).
	const [pushedPet, setPushedPet] = useState<
		| {
				kind: "builtin";
				id: string;
		  }
		| {
				kind: "petdex";
				pkg: PetdexPackage;
		  }
		| null
	>(null);
	const pet = pushedPet ?? localPet;
	// Surface shading (pet-decor.ts) — the floating pet is the one renderer
	// that has NO settings page of its own, so it subscribes to the same
	// broadcast the composer/avatar do rather than receiving a prop.
	const decor = usePetDecor();
	const [mood, setMood] = useState<PetMood>("rest");
	// The 31-state session reading pushed from the main window. Separate from
	// `mood` for the same reason the two axes exist at all: the mood picks the
	// spritesheet row, the state picks the face / motion / effects.
	const [sessionState, setSessionState] = useState<PetState | null>(null);
	const [hovering, setHovering] = useState(false);
	const [dragging, setDragging] = useState(false);
	// Ambient idle choreography: while the pet sits calm at rest, briefly swap
	// to a livelier idle row (thinking / lingering) so it has a life of its own
	// instead of breathing in place forever (open-design `pet-overlay` parity).
	const [ambientMood, setAmbientMood] = useState<PetMood | null>(null);
	// Transient user reaction (poke / notice / pre-sleep). Layered OVER the
	// mood, never written to it — see pet-face.ts PET_INTERACTIONS.
	const [interaction, setInteraction] = useState<PetInteraction | null>(null);
	// Horizontal drag direction: the dragging row's frames are a fixed-
	// direction walk cycle, so moving the other way must mirror them
	// (BitFun doesn't — it reads as running backwards on rightward drags).
	const [flip, setFlip] = useState(false);
	const [sizeScale, setSizeScale] = useState<number>(() => petScale());
	const [dockSide, setDockSide] = useState<"left" | "right" | null>(null);
	const [unreadCount, setUnreadCount] = useState(0);
	// Sleep state (clawd-on-desk parity): after 60s of no interaction AND
	// no task activity, the pet dims and shows a "zzz" (CSS-only — no new
	// sprite rows needed for imported sheets). Any gesture or mood change
	// wakes it.
	const [sleeping, setSleeping] = useState(false);
	const bridge = (window as unknown as { electronAPI?: PetBridge }).electronAPI;
	const bumpRef = useRef<HTMLDivElement>(null);
	// RAF-coalesced drag move: pointermove can fire 120Hz+, and firing one
	// IPC per event queues up behind the main process's setPosition — the
	// window then lags the cursor and the lag noise shows up as jitter.
	// One move per animation frame with the LATEST client point (Clawd's
	// queueDragMove pattern) keeps the window glued to the cursor.
	const dragMoveRafRef = useRef<number | null>(null);
	const pendingMoveRef = useRef<{ clientX: number; clientY: number; screenX: number; screenY: number } | null>(null);
	// Click-vs-double-click discrimination: the first click's action (greet
	// + raise the main window) is deferred; if a second click lands within
	// DOUBLE_CLICK_MS it is cancelled and the random interaction plays.
	const lastClickRef = useRef(0);
	const clickTimerRef = useRef<number | null>(null);
	// Poke escalation + reaction lifetime. `pokes` counts presses within
	// POKE_COMBO_MS so a deliberate double-poke escalates while an accidental
	// double-tap merges; `reactionTimerRef` releases the override;
	// `lastReactionRef` remembers the previous random pick so a double-click
	// never repeats the same reaction back to back.
	const lastPokeRef = useRef(0);
	const [pokes, setPokes] = useState(0);
	const pokeTimerRef = useRef<number | null>(null);
	const reactionTimerRef = useRef<number | null>(null);
	const lastReactionRef = useRef<PetInteraction | null>(null);

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
		 *  click — otherwise moving the pet fires the click action. */
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
			if (payload.petState) setSessionState(payload.petState);
			if (typeof payload.scale === "number" && payload.scale > 0) setSizeScale(payload.scale);
			if (typeof payload.unreadCount === "number") setUnreadCount(payload.unreadCount);
			if (typeof payload.locale === "string") setLocale(payload.locale);
			// Active-pet override (petdex packages live in the main window's
			// localStorage — unreachable from here; the descriptor arrives
			// inline, spritesheet data URL and all).
			if (payload.pet) setPushedPet(payload.pet);
			// Main-window scheme push (the reliable path — storage events
			// don't fire cross-window under file://).
			if (payload.theme === "light" || payload.theme === "dark") {
				document.documentElement.dataset.theme = payload.theme;
				document.documentElement.dataset.colorScheme = payload.theme;
			}
			// Themed accent: the pet's shell/ring/eye palette is derived from
			// the main window's resolved --accent (pet-palette.ts), so the orb
			// follows the active theme axis (brand/ocean/jade/mono) instead of
			// a fixed brand gold. Inline the pushed value first — the pet
			// window never sets data-accent itself.
			if (typeof payload.accent === "string" && payload.accent) {
				document.documentElement.style.setProperty("--accent", payload.accent);
			}
			if (payload.theme || payload.accent) applyPetPalette(document.documentElement);
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

	// Gaze refs: the engine reads gazeRef per frame (no React state — an
	// IPC stream must never re-render). gazeMirrorRef tracks the sprite's
	// mirror state for write-time compensation: the flip is CSS scaleX(-1)
	// over the whole rig, so a mirrored pet renders its gaze mirrored too —
	// negate x on write and the pet keeps looking at the TRUE cursor.
	const gazeRef = useRef<GazeVec | null>(null);
	const gazeMirrorRef = useRef(false);
	useEffect(() => {
		if (!bridge?.onPetGaze) return;
		return bridge.onPetGaze?.(gaze => {
			gazeRef.current = { x: gazeMirrorRef.current ? -gaze.x : gaze.x, y: gaze.y };
		});
	}, []);
	useEffect(() => {
		gazeMirrorRef.current = flip || dockSide === "left";
	}, [flip, dockSide]);

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
			const playMs = AMBIENT_PLAY_MIN_MS + Math.floor(Math.random() * AMBIENT_PLAY_VARIANCE_MS);
			playTimer = window.setTimeout(() => {
				setAmbientMood(null);
				const restMs = AMBIENT_REST_MIN_MS + Math.floor(Math.random() * AMBIENT_REST_VARIANCE_MS);
				restTimer = window.setTimeout(playBeat, restMs);
			}, playMs);
		};

		const initialDelay = AMBIENT_INITIAL_DELAY_MIN_MS + Math.floor(Math.random() * AMBIENT_INITIAL_DELAY_VARIANCE_MS);
		restTimer = window.setTimeout(playBeat, initialDelay);

		return () => {
			if (playTimer !== undefined) window.clearTimeout(playTimer);
			if (restTimer !== undefined) window.clearTimeout(restTimer);
			setAmbientMood(null);
		};
	}, [mood, hovering, dragging, pet]);

	// Sleep scheduler: 60s with no gesture and no task activity (mood at
	// rest) → asleep. Any change to mood/hover/drag re-runs this effect,
	// which both wakes the pet and restarts the timer.
	useEffect(() => {
		if (mood !== "rest" || hovering || dragging) {
			setSleeping(state => (state ? false : state));
			return;
		}
		const SLEEP_AFTER_MS = 60_000;
		const timer = window.setTimeout(() => setSleeping(true), SLEEP_AFTER_MS);
		return () => window.clearTimeout(timer);
	}, [mood, hovering, dragging]);

	// Pre-sleep drowse: 20s before the 60s sleep latch, the pet starts
	// dropping off — half-lidded eyes with a long, heavy blink — so the
	// transition into sleep is a wind-down rather than a hard cut. Runs on
	// the same cancel conditions as the sleep scheduler (any gesture or
	// task activity wakes it) and yields to a live reaction.
	useEffect(() => {
		if (mood !== "rest" || hovering || dragging) {
			setInteraction(cur => (cur === "dozing" ? null : cur));
			return;
		}
		const DROWSE_AFTER_MS = 40_000;
		const timer = window.setTimeout(() => setInteraction("dozing"), DROWSE_AFTER_MS);
		return () => window.clearTimeout(timer);
	}, [mood, hovering, dragging]);

	// Release any transient reaction after POKE_HOLD_MS. Keyed on the value
	// so a new reaction (a second poke, a double-click pick, an idle beat)
	// restarts the hold instead of expiring on the previous one's clock.
	// `dozing` is excluded — it is a scheduler-owned STATE (the pre-sleep
	// drowse), released by its own wake conditions, not a gesture. (This
	// also fixes the idle peek/curious beats, which the old three-name
	// release list let stick forever once scheduled.)
	useEffect(() => {
		if (interaction === null || interaction === "dozing") return;
		reactionTimerRef.current = window.setTimeout(() => {
			reactionTimerRef.current = null;
			setInteraction(null);
		}, POKE_HOLD_MS);
		return () => {
			if (reactionTimerRef.current !== null) {
				window.clearTimeout(reactionTimerRef.current);
				reactionTimerRef.current = null;
			}
		};
	}, [interaction]);

	// "Caught looking" idle beat: while calm at rest, occasionally glance off
	// to one side (peek) or tilt toward the cursor (curious) — the pet has an
	// inner life rather than a single resting face. Each beat holds for
	// POKE_HOLD_MS (the shared transient-reaction release above) and the
	// scheduler re-arms once `interaction` returns to null.
	useEffect(() => {
		if (mood !== "rest" || hovering || dragging || interaction !== null) return;
		const PEEK_MIN_MS = 12_000;
		const PEEK_VARIANCE_MS = 14_000;
		const timer = window.setTimeout(
			() => setInteraction(Math.random() < 0.5 ? "peek" : "curious"),
			PEEK_MIN_MS + Math.floor(Math.random() * PEEK_VARIANCE_MS),
		);
		return () => window.clearTimeout(timer);
	}, [mood, hovering, dragging, interaction]);

	// Light/dark scheme: mirror the main app's scheme (local pref +
	// system default); the main window's petActivity push overrides it.
	// Both paths re-derive the themed pet palette from the resolved
	// --accent (local tokens on first paint; the pushed accent wins once
	// the first petActivity lands).
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
			applyPetPalette(doc);
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

	// Report the interactive rect (pet + badge) whenever the layout changes.
	// The MAIN process resizes this window's click-through state; re-measure
	// on window resize too.
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
		const ro = new ResizeObserver(report);
		for (const el of document.querySelectorAll(".pet-window__pet, .pet-window__badge")) {
			ro.observe(el);
		}
		return () => {
			window.removeEventListener("resize", report);
			ro.disconnect();
		};
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

	// Blob squash (blobstudio.xyz parity): every poke reaction replays a
	// quick squash-and-stretch on the sprite wrapper — the press gets a
	// physical "clicked" feel even on petdex sheets, whose faces cannot
	// change. Dozing is a slow wind-down, not a poke: no squash.
	const squashRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!interaction || interaction === "dozing") return;
		const el = squashRef.current;
		if (!el) return;
		el.classList.remove("pet-window__squash");
		void el.offsetWidth; // force reflow so the class re-triggers
		el.classList.add("pet-window__squash");
	}, [interaction]);

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
		// would otherwise fire the deferred single-click action too).
		if (e.button !== 0) return;
		// A new gesture starts: any deferred single-click action from the
		// previous click is void — otherwise a click followed within the
		// double-click window by a drag would fire it mid-drag.
		if (clickTimerRef.current !== null) {
			window.clearTimeout(clickTimerRef.current);
			clickTimerRef.current = null;
		}
		// A gesture wakes the sleeper (and restarts the 60s timer via the
		// hover state this pointerdown is about to produce).
		setSleeping(false);
		// Poke reaction: the FIRST press of a burst startles, a quick
		// follow-up delights. A press that turns into a drag gets overridden
		// by `dragging` in displayMood, so reacting here is safe — the drag
		// takes visual priority the instant it crosses the threshold.
		const now = performance.now();
		const combo = now - lastPokeRef.current <= POKE_COMBO_MS;
		const nextPokes = combo ? Math.min(pokes + 1, 4) : 1;
		setPokes(nextPokes);
		lastPokeRef.current = now;
		setInteraction(nextPokes > 1 ? "delighted" : "startled");
		if (pokeTimerRef.current !== null) window.clearTimeout(pokeTimerRef.current);
		pokeTimerRef.current = window.setTimeout(() => setPokes(0), POKE_COMBO_MS);
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
		pendingMoveRef.current = { clientX, clientY, screenX: window.screenX, screenY: window.screenY };
		if (dragMoveRafRef.current !== null) return;
		dragMoveRafRef.current = requestAnimationFrame(() => {
			dragMoveRafRef.current = null;
			const p = pendingMoveRef.current;
			pendingMoveRef.current = null;
			if (!p || !dragRef.current.dragging) return;
			void bridge?.movePetWindowByClient?.(p.clientX, p.clientY, p.screenX, p.screenY);
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
		// path and greets the pet alongside the native menu.
		if (e.button !== 0) return;
		const s = dragRef.current;
		s.pressed = false;
		s.dragging = false;
		if (s.moved) {
			// A completed drag is a drag, never a click — the greeting must
			// not fire after moving the pet.
			s.moved = false;
			setDragging(false);
			void bridge?.petDragEnd?.();
			return;
		}
		// Click vs double-click: a double-click plays a random interaction
		// reaction from the full set (dozing excluded — waking up is the
		// drowse scheduler's job; never the same pick twice in a row). A
		// single click greets the pet and raises the main window (the old
		// bubble-panel popup is gone — the bubbles carry their own hover
		// actions now, 2026-09-21 user: 单击弹窗删除，改为前台显示客户端窗口).
		const now = Date.now();
		if (now - lastClickRef.current <= DOUBLE_CLICK_MS) {
			if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
			clickTimerRef.current = null;
			lastClickRef.current = 0;
			const pick = randomPetInteraction(lastReactionRef.current, ["dozing"]);
			lastReactionRef.current = pick;
			setInteraction(pick);
			// Disarm (no drag happened — pointer just went down and up).
			void bridge?.petDragEnd?.();
			return;
		}
		lastClickRef.current = now;
		// Defer the single-click action by the double-click window so a
		// double click never fires it — and so its greeting never flashes
		// before the random double-click pick takes over.
		clickTimerRef.current = window.setTimeout(() => {
			clickTimerRef.current = null;
			setInteraction("greeting");
			void bridge?.focusMainWindow?.();
			// Disarm after the click's pointer stream ends too.
			void bridge?.petDragEnd?.();
		}, DOUBLE_CLICK_MS + 20);
	};

	if (!enabled) return null;

	const displayMood = dragging ? "dragging" : hovering ? "hover" : (ambientMood ?? mood);
	// The session state yields to every local choreography: dragging and hover
	// are pointer states, and the ambient idle choreography swaps the idle ROW
	// for a livelier one — two choreographies fighting over the same face is
	// exactly what made the old behaviour read as random.
	const displayState = dragging || hovering || ambientMood ? null : sessionState;
	// Reactions yield to drag and sleep — but NOT to hover. The pet window is
	// click-through, so `hovering` comes from the main process's cursor poll
	// and is TRUE for the entire duration of any click gesture: the cursor is
	// necessarily inside the hitbox from pointerdown to pointerup. Yielding to
	// it made every reaction dead on arrival — double-click sets `interaction`,
	// the same frame's hover state wipes it, and the pet sits there unchanged
	// (2026-09-20 user: 「桌宠双击可能由于鼠标悬停的状态导致无交互状态」).
	// Drag still wins: while dragging the pet is already answering the pointer
	// with a whole different row, and a poke face fighting it read as noise.
	// Sleep still wins: once the eyes have closed the dozing face is the only
	// readable thing and the zzz layer carries that state on its own.
	const displayInteraction = dragging || sleeping ? null : interaction;
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
			<div className="pet-window__stage" style={{ "--gui-pet-window-scale": sizeScale } as CSSProperties}>
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
					className={`pet-window__pet${sleeping ? " pet-window__pet--sleeping" : ""}`}
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
					<div
						ref={squashRef}
						className={`pet-window__pet-flip${mirrored ? " pet-window__pet-flip--mirror" : ""}`}
					>
						<PetSprite
							mood={displayMood}
							state={displayState}
							// The desktop pet is the largest host (104px box) —
							// every effect runs at full count here.
							tier="full"
							pet={pet}
							/* The builtin SVG derives its own size from
							 * `--gui-pet-window-scale` (pet-window.css); this
							 * is the fallback box. The petdex sheets still need
							 * the real number, and `scale` is the user's size
							 * slider for both. */
							size={104}
							scale={sizeScale}
							gloss={decor.gloss}
							accessory={decor.accessory}
							frozen={displayMood === "hover"}
							gazeRef={gazeRef}
							interaction={displayInteraction}
						/>
					</div>
					{sleeping && (
						// Sleep indicator (CSS-only): floats up from the
						// sprite's head, aria-hidden — purely decorative.
						<span className="pet-window__zzz" aria-hidden="true">
							z z z
						</span>
					)}
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
