/**
 * Pet window entry (pet.html) — the floating desktop companion (伙伴):
 * the active pet (builtin SVG or Petdex spritesheet) with a mood driven by
 * the main window's session store, hidden-stack badge, and a drag/hover/dock
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
 * - hover/dragging switch the petdex sprite to rows 1/2;
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
import { type GazeVec, PetSprite, type PetSpriteAction, usePet, usePetDecor } from "./components/PetSprite";
import { PET_ENTER_MS, PetTransition, type PetTransitionPhase } from "./components/PetTransition";
import {
	descriptorFromPush,
	type PetActivity,
	type PetDescriptor,
	type PetInteraction,
	type PetMood,
	type PetState,
	petAmbientActions,
	petCustomActions,
	petScale,
	randomPetInteraction,
} from "./lib/pet";
import type { PetGestureInput } from "./lib/pet-gesture";
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

// Local pet chrome comes first; shared tokens supply the overlay glass without
// painting the transparent page. Component rules precede the overlay fallback.
import "./styles/pet-window.css";
import "@musepi/client-core/src/styles/tokens.css";
import "./styles/gui.css";
import "@musepi/client-core/src/styles/overlay-fallback.css";

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
	/** The shell is showing this window — replay the entrance. */
	onPetShowing?(cb: () => void): () => void;
	/** The shell is about to hide this window — dissolve the pet first. */
	onPetAnimatingOut?(cb: () => void): () => void;
	/** Reduced motion: report it so the shell skips the dissolve delay. */
	setPetReducedMotion?(reduced: boolean): Promise<unknown>;
	/** Pet-side control → advance expanded → stacked → count → stacked. */
	bubblesAdvanceMode?(): Promise<unknown>;
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
	const [pushedPet, setPushedPet] = useState<PetDescriptor | null>(null);
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
	const [ambientAction, setAmbientAction] = useState<PetSpriteAction | null>(null);
	const [customAction, setCustomAction] = useState<PetSpriteAction | null>(null);
	const actionNonceRef = useRef(0);
	const ambientCompletionRef = useRef<(() => void) | null>(null);
	const lastCustomActionRef = useRef<string | null>(null);
	// Transient user reaction (poke / notice / pre-sleep). Layered OVER the
	// mood, never written to it — see pet-face.ts PET_INTERACTIONS.
	const [interaction, setInteraction] = useState<PetInteraction | null>(null);
	// Horizontal drag direction: the dragging row's frames are a fixed-
	// direction walk cycle, so moving the other way must mirror them
	// (BitFun doesn't — it reads as running backwards on rightward drags).
	const [flip, setFlip] = useState(false);
	const [sizeScale, setSizeScale] = useState<number>(() => petScale());
	const [dockSide, setDockSide] = useState<"left" | "right" | null>(null);
	// The single pet-side control mirrors the bubble window's three modes.
	// It stays visible whenever items exist; only count mode shows a number.
	const [bubblesState, setBubblesState] = useState<{ mode: "expanded" | "stacked" | "hidden"; count: number }>({
		mode: "stacked",
		count: 0,
	});
	// Sleep state: after 60s of no interaction AND
	// no task activity, the pet dims and shows a "zzz" (CSS-only — no new
	// sprite rows needed for imported sheets). Any gesture or mood change
	// wakes it.
	const [sleeping, setSleeping] = useState(false);
	const bridge = (window as unknown as { electronAPI?: PetBridge }).electronAPI;
	const bumpRef = useRef<HTMLDivElement>(null);
	// The builtin frame loop samples this input directly. Pointer events update
	// only refs; Petdex continues to use its spritesheet rows and mirror state.
	const gestureRef = useRef<PetGestureInput>({
		pressed: false,
		dragging: false,
		vx: 0,
		vy: 0,
		at: 0,
		releasedAt: null,
	});
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
			if (payload.bubbles) setBubblesState(payload.bubbles);
			if (typeof payload.locale === "string") setLocale(payload.locale);
			// Active-pet override (petdex packages live in the main window's
			// localStorage — unreachable from here; the descriptor arrives
			// inline, spritesheet data URL and all).
			const pushed = descriptorFromPush(payload.pet);
			if (pushed) setPushedPet(pushed);
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
			gazeRef.current = { x: gazeMirrorRef.current ? -gaze.x : gaze.x, y: gaze.y, at: performance.now() };
		});
	}, []);
	useEffect(() => {
		gazeMirrorRef.current = pet.kind === "petdex" && ((flip && pet.pkg.format !== "atlas") || dockSide === "left");
	}, [flip, dockSide, pet]);

	// Dock side after an edge snap (settings → 宠物 → 挂靠左右侧): the
	// main process pushes it; the edge highlight bar follows.
	useEffect(() => {
		if (!bridge?.onPetDock) return;
		return bridge.onPetDock?.(setDockSide);
	}, []);

	// Show/hide transition. The particle orb is a transition, never the pet:
	// the shell signals every show (the window outlives its own hide, so
	// mounting only covers the first one) and every hide, and holds the
	// window open for the dissolve. Reduced motion is reported to the shell
	// — it skips the hold — and the stylesheet drops the particles and the
	// scale, so both directions stay instant.
	// Mount is a show: start in the enter phase so the first painted frame is
	// already the transition, never a full-size sphere that then jumps back.
	const [transition, setTransition] = useState<PetTransitionPhase>("enter");
	const [showNonce, setShowNonce] = useState(0);
	const enterTimerRef = useRef<number | null>(null);
	useEffect(() => {
		if (!bridge?.onPetShowing) return;
		return bridge.onPetShowing(() => setShowNonce(n => n + 1));
	}, []);
	useEffect(() => {
		if (!bridge?.onPetAnimatingOut) return;
		return bridge.onPetAnimatingOut(() => {
			if (enterTimerRef.current !== null) {
				window.clearTimeout(enterTimerRef.current);
				enterTimerRef.current = null;
			}
			setTransition("leave");
		});
	}, []);
	useEffect(() => {
		if (!bridge?.setPetReducedMotion) return;
		const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
		const report = (): void => void bridge.setPetReducedMotion?.(mq.matches);
		report();
		mq.addEventListener("change", report);
		return () => mq.removeEventListener("change", report);
	}, []);
	// First paint and every later show replay the converge.
	useEffect(() => {
		setTransition("enter");
		enterTimerRef.current = window.setTimeout(() => {
			enterTimerRef.current = null;
			setTransition("idle");
		}, PET_ENTER_MS);
		return () => {
			if (enterTimerRef.current !== null) {
				window.clearTimeout(enterTimerRef.current);
				enterTimerRef.current = null;
			}
		};
	}, [showNonce]);

	// Ambient idle choreography scheduler (open-design `pet-overlay` parity).
	// While the pet rests calm and nothing is hovering/dragging, occasionally
	// play a livelier idle row (thinking / lingering) for a few seconds, then
	// return to the baseline rest for a longer, randomised rest window. Both
	// windows are randomised so the rhythm never feels mechanical; the rest
	// window is deliberately generous so the pet reads calm rather than fidgety.
	// Any user gesture (hover / drag) cancels the beat via cleanup.
	useEffect(() => {
		if (mood !== "rest" || hovering || dragging || customAction) {
			setAmbientMood(null);
			setAmbientAction(null);
			return;
		}
		if (pet.kind !== "petdex") return;
		const AMBIENT_PLAY_MIN_MS = 1800;
		const AMBIENT_PLAY_VARIANCE_MS = 1200;
		const AMBIENT_REST_MIN_MS = 9000;
		const AMBIENT_REST_VARIANCE_MS = 9000;
		const AMBIENT_INITIAL_DELAY_MIN_MS = 4000;
		const AMBIENT_INITIAL_DELAY_VARIANCE_MS = 4000;
		const AMBIENT_MOODS: PetMood[] = ["waiting", "analyzing"];
		const packageActions = petAmbientActions(pet.pkg);
		let playTimer: number | undefined;
		let restTimer: number | undefined;

		const scheduleRest = (): void => {
			const restMs = AMBIENT_REST_MIN_MS + Math.floor(Math.random() * AMBIENT_REST_VARIANCE_MS);
			restTimer = window.setTimeout(playBeat, restMs);
		};
		const finishPackageAction = (): void => {
			setAmbientAction(null);
			scheduleRest();
		};
		ambientCompletionRef.current = finishPackageAction;

		function playBeat(): void {
			if (packageActions.length > 0) {
				const name = packageActions[Math.floor(Math.random() * packageActions.length)]!;
				actionNonceRef.current += 1;
				setAmbientAction({ name, nonce: actionNonceRef.current });
				return;
			}
			setAmbientMood(AMBIENT_MOODS[Math.floor(Math.random() * AMBIENT_MOODS.length)] ?? "waiting");
			const playMs = AMBIENT_PLAY_MIN_MS + Math.floor(Math.random() * AMBIENT_PLAY_VARIANCE_MS);
			playTimer = window.setTimeout(() => {
				setAmbientMood(null);
				scheduleRest();
			}, playMs);
		}

		const initialDelay = AMBIENT_INITIAL_DELAY_MIN_MS + Math.floor(Math.random() * AMBIENT_INITIAL_DELAY_VARIANCE_MS);
		restTimer = window.setTimeout(playBeat, initialDelay);

		return () => {
			ambientCompletionRef.current = null;
			if (playTimer !== undefined) window.clearTimeout(playTimer);
			if (restTimer !== undefined) window.clearTimeout(restTimer);
			setAmbientMood(null);
			setAmbientAction(null);
		};
	}, [mood, hovering, dragging, pet, customAction]);

	useEffect(() => {
		if (mood === "rest") return;
		setCustomAction(null);
	}, [mood]);

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
		let frame = 0;
		const schedule = (): void => {
			if (!frame) frame = requestAnimationFrame(report);
		};
		const report = (): void => {
			frame = 0;
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
			// ResizeObserver misses transform-only motion. Track the pet's finite
			// entrance, hover and landing animations so the bubble anchor and the
			// native hitbox never retain the pre-animation sprite position.
			if (pet?.getAnimations().some(animation => animation.playState === "running")) schedule();
		};
		report();
		window.addEventListener("resize", schedule);
		const ro = new ResizeObserver(schedule);
		const pet = document.querySelector<HTMLElement>(".pet-window__pet");
		for (const el of document.querySelectorAll(".pet-window__pet, .pet-window__badge")) ro.observe(el);
		const motionEvents = [
			"animationstart",
			"animationend",
			"animationcancel",
			"transitionrun",
			"transitionend",
			"transitioncancel",
		] as const;
		for (const type of motionEvents) pet?.addEventListener(type, schedule);
		const mo = new MutationObserver(schedule);
		const root = document.getElementById("root");
		if (root) mo.observe(root, { childList: true, subtree: true });
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener("resize", schedule);
			for (const type of motionEvents) pet?.removeEventListener(type, schedule);
			ro.disconnect();
			mo.disconnect();
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

	// Petdex needs the wrapper squash because its frames cannot react. The
	// builtin already owns an interaction spring and a press deformation;
	// applying both would double its bounce.
	const squashRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (pet.kind !== "petdex" || !interaction || interaction === "dozing") return;
		const el = squashRef.current;
		if (!el) return;
		el.classList.remove("pet-window__squash");
		void el.offsetWidth;
		el.classList.add("pet-window__squash");
	}, [interaction, pet.kind]);

	const releaseGesture = (): void => {
		const now = performance.now();
		gestureRef.current = {
			pressed: false,
			dragging: false,
			vx: 0,
			vy: 0,
			at: now,
			releasedAt: now,
		};
	};

	const petIdentity = pet.kind === "petdex" ? pet.pkg.id : pet.id;
	// The renderer kind is the mechanism boundary. A selection change ends the
	// old mechanism's gesture before the other engine mounts: Petdex must not
	// inherit orb deformation, and the orb must not inherit a bitmap mirror,
	// walk row or pending window move. Display position remains independent.
	useEffect(() => {
		setDragging(false);
		setFlip(false);
		setAmbientMood(null);
		setAmbientAction(null);
		setCustomAction(null);
		setInteraction(null);
		const drag = dragRef.current;
		drag.pressed = false;
		drag.dragging = false;
		drag.dirAcc = 0;
		drag.moved = false;
		if (dragMoveRafRef.current !== null) cancelAnimationFrame(dragMoveRafRef.current);
		dragMoveRafRef.current = null;
		pendingMoveRef.current = null;
		releaseGesture();
		void bridge?.petDragEnd?.();
	}, [pet.kind, petIdentity]);

	const resetDrag = (): void => {
		if (!dragRef.current.pressed) return;
		dragRef.current.pressed = false;
		dragRef.current.dragging = false;
		releaseGesture();
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
		// The first press startles and a quick follow-up delights. The builtin
		// keeps that expression during a drag; Petdex switches to its walk row.
		const now = performance.now();
		gestureRef.current = { pressed: true, dragging: false, vx: 0, vy: 0, at: now, releasedAt: null };
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
			const moveNow = performance.now();
			const moveDt = Math.max(8, moveNow - gestureRef.current.at);
			gestureRef.current = {
				pressed: true,
				dragging: true,
				vx: ((e.clientX - s.lastX) * 1000) / moveDt,
				vy: ((e.clientY - s.lastY) * 1000) / moveDt,
				at: moveNow,
				releasedAt: null,
			};
			if (pet.kind === "petdex") {
				// Only bitmap walk frames need directional mirroring.
				s.dirAcc += e.clientX - s.lastX;
				if (s.dirAcc > DIR_FLIP_THRESHOLD_PX) {
					setFlip(true);
					s.dirAcc = 0;
				} else if (s.dirAcc < -DIR_FLIP_THRESHOLD_PX) {
					setFlip(false);
					s.dirAcc = 0;
				}
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
		releaseGesture();
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
			const packageActions = pet.kind === "petdex" && mood === "rest" ? petCustomActions(pet.pkg) : [];
			if (packageActions.length > 0) {
				const candidates = packageActions.filter(name => name !== lastCustomActionRef.current);
				const pool = candidates.length > 0 ? candidates : packageActions;
				const name = pool[Math.floor(Math.random() * pool.length)]!;
				lastCustomActionRef.current = name;
				actionNonceRef.current += 1;
				setCustomAction({ name, nonce: actionNonceRef.current });
				setInteraction(null);
			} else {
				const pick = randomPetInteraction(lastReactionRef.current, ["dozing"]);
				lastReactionRef.current = pick;
				setInteraction(pick);
			}
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

	const petdexPointer = pet.kind === "petdex" && (dragging || hovering);
	const displayMood =
		pet.kind === "petdex" && dragging
			? "dragging"
			: pet.kind === "petdex" && hovering
				? "hover"
				: (ambientMood ?? mood);
	// Pointer rows belong to Petdex. The orb keeps its session direction and
	// composes pointer deformation on the independent gesture rig.
	const displayState = petdexPointer || ambientMood ? null : sessionState;
	// Package actions play only over a calm rest row. Pointer, sleep and live
	// session states keep their existing priority; a hidden one-shot resumes
	// when the pet returns to rest instead of replacing a more important row.
	const displayAction =
		pet.kind === "petdex" && !petdexPointer && !ambientMood && !sleeping && mood === "rest"
			? (customAction ?? ambientAction)
			: null;
	// Sleep owns the face. Petdex drag owns its walk row; the builtin keeps its
	// poke expression while the gesture rig carries the drag.
	const displayInteraction = (pet.kind === "petdex" && dragging) || sleeping ? null : interaction;
	// Explicit atlases own separate left/right rows. Mirroring those rows would
	// reverse the direction a second time; legacy sheets still need the mirror.
	const mirrored = pet.kind === "petdex" && ((flip && pet.pkg.format !== "atlas") || dockSide === "left");
	// The transition belongs to the brand sphere — an imported spritesheet
	// has no sphere to converge into, so petdex keeps the instant swap.
	const petTransition = pet.kind === "builtin" ? transition : "idle";

	return (
		<div
			className={`pet-window${dockSide ? ` pet-window--dock-${dockSide}` : ""}`}
			data-pet-transition={petTransition}
		>
			{/* The stage shrink-wraps the sprite so the single three-state
			 * control stays 8px beside the character at every pet scale. */}
			<div className="pet-window__stage" style={{ "--gui-pet-window-scale": sizeScale } as CSSProperties}>
				{bubblesState.count > 0 && (
					<button
						type="button"
						className={`pet-window__badge pet-window__badge--${bubblesState.mode}`}
						aria-label={
							bubblesState.mode === "hidden"
								? t("settings.petBubblesShow")
								: bubblesState.mode === "expanded"
									? t("settings.petBubblesCollapse")
									: t("settings.petBubblesHide")
						}
						title={
							bubblesState.mode === "hidden"
								? t("settings.petBubblesShow")
								: bubblesState.mode === "expanded"
									? t("settings.petBubblesCollapse")
									: t("settings.petBubblesHide")
						}
						onClick={() => void bridge?.bubblesAdvanceMode?.()}
					>
						{bubblesState.mode === "hidden" ? (bubblesState.count > 99 ? "99+" : bubblesState.count) : "⌃"}
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
							frozen={pet.kind === "petdex" && displayMood === "hover"}
							gazeRef={gazeRef}
							gestureRef={gestureRef}
							interaction={displayInteraction}
							action={displayAction}
							direction={flip ? "right" : "left"}
							onActionEnd={() => {
								if (customAction) {
									setCustomAction(null);
									return;
								}
								if (ambientCompletionRef.current) ambientCompletionRef.current();
								else setAmbientAction(null);
							}}
						/>
					</div>
					<PetTransition phase={petTransition} />
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

// Platform-aware overlays must not activate the opaque workspace backdrop.
document.documentElement.dataset.transparentWindow = "true";
initTooltips();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<PetApp />
	</StrictMode>,
);
