import type { CSSProperties, MutableRefObject, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
	getScrollbarSkin,
	readAlwaysShowScrollbar,
	readScrollbarStyle,
	SCROLLBAR_ALWAYS_CHANGED_EVENT,
	SCROLLBAR_SKINS_CHANGED_EVENT,
	SCROLLBAR_STYLE_CHANGED_EVENT,
	type ScrollbarSkin,
} from "../lib/scrollbar-skins";
import { PacMan } from "../vendor/pac-man";

/** Rail pool size. Beyond this the coldest slot is recycled rather than
 *  dropping the newest scroll signal. */
const MAX_RAILS = 6;
/** Horizontal track inset from each edge, so it clears the vertical thumb. */
const H_EDGE_INSET = 4;
/** Vertical track inset from the container's right edge. */
const V_EDGE_INSET = 4;
/** Smallest thumb that stays grabbable. */
const MIN_THUMB = 24;
/** ms of stillness before the rail drops to its faint idle state. */
const HIDE_MS = 1000;
/** ms an idle ghost keeps its slot before releasing it back to the pool. */
const RELEASE_MS = 5000;
/** How recently a real gesture must have landed for a scroll to count as
 *  user intent. */
const INTENT_WINDOW_MS = 250;
/** Liveness sweep period for rails whose container may have died while idle. */
const PROBE_MS = 600;
/** Gummy release spring — squash-and-stretch relaxes to this transform. */
const GUMMY_RELEASE = "transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)";

/** Keys that scroll a container. Without them a keyboard-only scroll is
 *  indistinguishable from our own programmatic `scrollTop` writes. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

type Axis = "v" | "h";

/** The four stable elements a slot owns, captured by the pool on mount. */
interface RailSlotRefs {
	root: HTMLDivElement | null;
	vertical: HTMLDivElement | null;
	horizontal: HTMLDivElement | null;
	/** Pac-man's eaten-bead run — the progress readout on that base. */
	eaten: HTMLDivElement | null;
}

/**
 * One rail slot, bound to at most one container at a time.
 *
 * `vLen` / `hLen` (thumb lengths) and `vScale` / `hScale` (thumb pixels per
 * scroll pixel) are resolved once per measure pass, so a scroll frame reads
 * only `scrollTop` / `scrollLeft` and writes only `transform`.
 */
interface Rail {
	slot: number;
	root: HTMLDivElement;
	vertical: HTMLDivElement;
	horizontal: HTMLDivElement;
	eaten: HTMLDivElement | null;
	/** Container this slot currently indicates, or null when the slot is free. */
	target: HTMLElement | null;
	vLen: number;
	hLen: number;
	/** Rail lengths the thumbs travel in, and where the rails start. The drag
	 *  handler inverts exactly the same numbers position uses, so the thumb
	 *  cannot separate from the pointer mid-drag. */
	vTrack: number;
	hTrack: number;
	/** Scrollable extent per axis, so the pacman base can derive one progress
	 *  scalar for both its glyph and its eaten bead run. */
	vRange: number;
	hRange: number;
	vScale: number;
	hScale: number;
	vOverflow: boolean;
	hOverflow: boolean;
	/** A scroll landed since the last position pass — the hot path's only trigger. */
	dirty: boolean;
	/** The gummy release spring is armed on the thumb and will animate the next
	 *  transform write. `position` disarms it before moving the thumb; only
	 *  `armSettle` arms it, so the spring plays when scrolling stops. */
	releaseArmed: boolean;
	/** The container's box may have changed; the next pass re-measures. */
	needsMeasure: boolean;
	/** Fingerprint of the geometry the last measure derived from. An unchanged
	 *  fingerprint makes the next measure a no-op, which is what keeps
	 *  `vScale` from drifting while a virtualizer nudges its spacer. */
	measureKey: string;
	/** Monotonic idle deadline — a scroll burst only rewrites the timestamp. */
	hideAt: number;
	hideTimer: number;
	settleTimer: number;
	/** Live drag, or null. Also gates the idle timer. */
	/** Live drag, or null. Also gates the idle timer. The grab POINT is the
	 *  origin: a move reads the rail's current scale and inverts `position`
	 *  exactly, so the thumb tracks the pointer 1:1 even when the content
	 *  height shifts mid-drag. */
	drag: { axis: Axis; pointerId: number; pointerStart: number; grabOffset: number } | null;
	/** Monotonic deadline for releasing an idle slot back to the pool. */
	releaseAt: number;
	/** Last time this rail moved — pool eviction order. */
	lastUsed: number;
	/** A real gesture landed on this container at this time. */
	intentAt: number;
	overThumb: boolean;
	overContainer: boolean;
	resizeObserver: ResizeObserver | null;
	mutationObserver: MutationObserver | null;
}

/** The pool's imperative surface. Lives in a ref so effects that re-run on a
 *  skin or preference change can drive it without rebuilding the pool. */
interface RailEngine {
	measure(rail: Rail): boolean;
	position(rail: Rail): void;
	indicate(target: HTMLElement, rail: Rail): void;
	retire(target: HTMLElement, rail: Rail): void;
	armIdle(rail: Rail): void;
	/** Re-resolve the rail's elements from its slot. React replaces the slot's
	 *  subtree when the skin changes base (gummy renders one div, pacman a
	 *  fragment of four), so a rail holding the elements it captured at mount
	 *  writes every transform to a detached node and the visible thumb stays at
	 *  its CSS default — pinned to the top of the rail. */
	rebind(rail: Rail): void;
}

/**
 * Effective stacking level of the container a rail indicates: the nearest
 * ancestor (including itself) carrying a numeric z-index. The rail paints one
 * step above it, so any dialog / menu / toast that covers the scrolled
 * container also covers the rail — the rail used to pin z-index 4200 and float
 * over the update toast and modal backdrops (user: 滚动条覆盖更新弹窗).
 *
 * Nested contexts resolve pragmatically: the NEAREST numeric z wins, and the
 * walk stops early at a `position: fixed` overlay (update toast, modal
 * backdrop) since that level outranks everything below it. Contexts without a
 * numeric z (backdrop-filter glass, transforms, opacity) contribute no number
 * of their own — the walk keeps going and inherits the level from further up.
 * No numeric z anywhere → 0.
 *
 * Deliberately NOT cached per element: an ancestor's level changes at runtime
 * (a toast mounts, the maximized panel promotes to 850, a menu opens), and a
 * cached level outlives the state that produced it — painting the rail under
 * the scrim it is meant to follow. This walks once per measure pass, which
 * happens on scroll-start / resize / content change, never per scroll frame.
 */
function stackZ(el: HTMLElement): number {
	let z = 0;
	let node: Element | null = el;
	while (node && node !== document.body && node !== document.documentElement) {
		const cs = getComputedStyle(node);
		const zi = cs.zIndex;
		if (zi !== "auto") {
			const n = Number(zi);
			if (Number.isFinite(n)) {
				z = n;
				if (cs.position === "fixed") break;
			}
		}
		node = node.parentElement;
	}
	return z;
}

/** A container is gone when it left the document or collapsed to zero size. */
function isGone(el: HTMLElement): boolean {
	if (!el.isConnected) return true;
	const r = el.getBoundingClientRect();
	return r.width === 0 || r.height === 0;
}

const SCROLL_AXIS = new Set(["auto", "scroll", "overlay"]);

/**
 * Is this axis a scroll container? A box can be SHORTER than its content and
 * still not scroll: `overflow: hidden` clips. `scrollHeight` / `scrollWidth`
 * keep reporting the clipped overflow, so a geometry-only test invents a rail
 * on every strip that pads its row — the panel tab strip (30px box, 26px
 * chips, 6px bottom padding, `overflow-y: hidden`) grew a vertical thumb that
 * could never move and sat on top of the tab's close button. The range is
 * only meaningful where the user can actually scroll it.
 */
function isScrollAxis(el: HTMLElement, axis: "y" | "x"): boolean {
	const cs = getComputedStyle(el);
	return SCROLL_AXIS.has(axis === "y" ? cs.overflowY : cs.overflowX);
}

/** A container still overflows on at least one axis it can scroll. */
function overflows(el: HTMLElement): boolean {
	return (
		(el.scrollHeight > el.clientHeight + 1 && isScrollAxis(el, "y")) ||
		(el.scrollWidth > el.clientWidth + 1 && isScrollAxis(el, "x"))
	);
}

/** Thumb length, floored at the grabbable minimum and capped to the track. */
function clampThumb(length: number, track: number): number {
	if (track <= 0) return 0;
	return Math.min(track, Math.max(MIN_THUMB, Math.round(length)));
}

/**
 * Floating scroll indicator (Chromium 150+ / Electron 43).
 *
 * Chromium still parses `overflow: overlay` but lays it out exactly like
 * `auto` — the floating (zero-layout-width) scrollbar is gone. System
 * scrollbars are therefore hidden globally (gui-base.css `scrollbar-width:
 * none` + `::-webkit-scrollbar { display: none }`) so no container ever
 * squeezes or shifts when its content becomes scrollable, and this fixed
 * overlay draws a skin-driven progress rail in its place.
 *
 * ## Pool, not singleton
 *
 * `window` capture-phase `scroll` sees every scrollable container in the app,
 * so the overlay keeps a POOL of up to `MAX_RAILS` slots keyed by container:
 * two independently scrolling panes each hold their own rail. When the pool is
 * full the coldest slot is recycled — the container being scrolled right now
 * always keeps its rail.
 *
 * ## Measure / position split
 *
 * Every layout read lives in `measure`: rect, `scrollHeight` / `clientHeight`,
 * `scrollWidth` / `clientWidth`, and the resolved thumb scales
 * (`vScale` = thumb pixels per scroll pixel). `position` is the hot path and
 * reads only `scrollTop` / `scrollLeft`, writing only `transform` — so steady
 * scrolling causes no layout reads and no layout writes. Both reads-before-
 * writes orders are fixed: `measure` gathers every axis before the first
 * write, and `position` reads both offsets before writing either thumb.
 *
 * ## Visibility
 *
 * Attribute-driven (gui-misc.css): `data-visible` while indicating, `data-idle`
 * once scrolling stops. Idle does NOT hide the rail — it fades to a faint ghost
 * whose thumbs stay grabbable, so progress can be dragged at any time.
 *
 * Programmatic motion (virtualizer spacer writes, auto-follow, morph height,
 * focus restore) does NOT raise a rail: a scroll only counts when a real
 * gesture (wheel / touch / scroll key) landed on the container recently, or the
 * rail is already up, or it is being dragged or hovered. Always-visible mode does
 * NOT bypass that gate: it only changes how long an already-raised rail stays
 * lit, so the switch can never bolt a rail onto a hidden or nested container.
 *
 * ## Single exit
 *
 * Every condition that means "this rail has nothing to indicate" — unmounted,
 * zero-size, no longer overflowing, evicted from the pool — funnels through
 * `retire`. There is no path that leaves a rail painted with nothing behind it.
 */
export function FloatingScrollbar(): ReactNode {
	const slotCount = MAX_RAILS;
	const slotsRef = useRef<RailSlotRefs[]>(
		Array.from({ length: slotCount }, () => ({ root: null, vertical: null, horizontal: null, eaten: null })),
	);
	const railsRef = useRef<Map<HTMLElement, Rail>>(new Map());
	const freeRef = useRef<number[]>(Array.from({ length: slotCount }, (_, i) => i));
	const frameRef = useRef(0);
	const engineRef = useRef<RailEngine | null>(null);
	const dragRef = useRef<((slot: number, axis: Axis, e: ReactPointerEvent<HTMLDivElement>) => void) | null>(null);
	const skinRef = useRef<ScrollbarSkin>(getScrollbarSkin(readScrollbarStyle()));
	const sizeRef = useRef(skinRef.current.size);
	const [skinId, setSkinId] = useState<string>(() => readScrollbarStyle());
	const [alwaysShow, setAlwaysShow] = useState<boolean>(() => readAlwaysShowScrollbar());
	const alwaysRef = useRef(alwaysShow);

	// Skin picker / importer and the always-visible toggle notify; a light
	// re-render picks up the new values. Scrolling itself never re-renders.
	useEffect(() => {
		const onSkin = (): void => setSkinId(readScrollbarStyle());
		const onAlways = (): void => setAlwaysShow(readAlwaysShowScrollbar());
		window.addEventListener(SCROLLBAR_STYLE_CHANGED_EVENT, onSkin);
		window.addEventListener(SCROLLBAR_SKINS_CHANGED_EVENT, onSkin);
		window.addEventListener(SCROLLBAR_ALWAYS_CHANGED_EVENT, onAlways);
		return () => {
			window.removeEventListener(SCROLLBAR_STYLE_CHANGED_EVENT, onSkin);
			window.removeEventListener(SCROLLBAR_SKINS_CHANGED_EVENT, onSkin);
			window.removeEventListener(SCROLLBAR_ALWAYS_CHANGED_EVENT, onAlways);
		};
	}, []);

	const skin = getScrollbarSkin(skinId);
	skinRef.current = skin;
	sizeRef.current = skin.size;

	// The pool. Mounted once: skin and always-visible are read through refs so
	// switching either never tears observers down mid-scroll.
	useEffect(() => {
		const slots = slotsRef.current;
		const rails = railsRef.current;
		const free = freeRef.current;
		const mounted = slots.map((s, slot): Rail | null => {
			if (!s.root || !s.vertical || !s.horizontal) return null;
			return {
				slot,
				root: s.root,
				vertical: s.vertical,
				horizontal: s.horizontal,
				eaten: s.eaten,
				target: null,
				vLen: 0,
				hLen: 0,
				vTrack: 0,
				hTrack: 0,
				vRange: 0,
				hRange: 0,
				vScale: 0,
				hScale: 0,
				vOverflow: false,
				hOverflow: false,
				dirty: false,
				releaseArmed: false,
				needsMeasure: true,
				measureKey: "",
				hideAt: 0,
				hideTimer: 0,
				settleTimer: 0,
				drag: null,
				releaseAt: 0,
				lastUsed: 0,
				intentAt: 0,
				overThumb: false,
				overContainer: false,
				resizeObserver: null,
				mutationObserver: null,
			};
		});

		/**
		 * The single exit path. Anything that means "this rail has nothing to
		 * indicate" funnels here, so no stale rail can survive: the container
		 * unmounted or collapsed (disconnected / zero-size rect), its content
		 * shrank back to fitting (both axes within the +1px slack), or the slot
		 * was recycled for a hotter container.
		 */
		const retire = (target: HTMLElement, rail: Rail): void => {
			if (rails.get(target) !== rail) return;
			// A rail under the pointer survives: the user is actively scrolling
			// this container, so a momentary "content stopped overflowing" (a
			// virtualizer collapsing its spacer at the end of a drag) must not
			// tear the rail down. Tearing it down cleared `drag`, and every
			// later pointermove was ignored — an upward drag did nothing.
			if (rail.drag) return;
			rails.delete(target);
			rail.target = null;
			rail.vLen = 0;
			rail.hLen = 0;
			rail.vTrack = 0;
			rail.hTrack = 0;
			rail.vRange = 0;
			rail.hRange = 0;
			rail.vScale = 0;
			rail.hScale = 0;
			rail.vOverflow = false;
			rail.hOverflow = false;
			rail.drag = null;
			rail.overThumb = false;
			rail.overContainer = false;
			rail.measureKey = "";
			window.clearTimeout(rail.hideTimer);
			window.clearTimeout(rail.settleTimer);
			rail.hideTimer = 0;
			rail.settleTimer = 0;
			// Release the observers so a recycled slot never accumulates
			// watched elements (and never pins a detached subtree alive).
			rail.resizeObserver?.disconnect();
			rail.resizeObserver = null;
			rail.mutationObserver?.disconnect();
			rail.mutationObserver = null;
			target.removeEventListener("pointerenter", onContainerEnter);
			target.removeEventListener("pointerleave", onContainerLeave);
			delete rail.root.dataset.visible;
			delete rail.root.dataset.idle;
			if (!free.includes(rail.slot)) free.push(rail.slot);
		};

		/**
		 * Cold path. Reads every box the rail needs — rect, both scroll
		 * ranges, both client sizes, the ancestor stack level — and only then
		 * writes the root box, the thumb lengths and the two px-per-scroll-px
		 * scales. Gathering every axis before the first write is what keeps this
		 * pass from forcing a second layout.
		 *
		 * Returns false when the container has nothing left to indicate, which
		 * is the caller's cue to retire the rail.
		 */
		const measure = (rail: Rail): boolean => {
			const el = rail.target;
			if (!el?.isConnected) return false;
			// Measuring IS the resolution of `needsMeasure`; clearing it here
			// means every caller (first bind, resize, mutation, hover, skin
			// switch) measures exactly once and the following scroll frames
			// position only.
			rail.needsMeasure = false;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) return false;
			const vRange = el.scrollHeight - el.clientHeight;
			const hRange = el.scrollWidth - el.clientWidth;
			// Clipped overflow is not scrollable overflow: only a real scroll
			// container's range may raise a thumb (see `isScrollAxis`).
			const vScroll = vRange > 0 && isScrollAxis(el, "y");
			const hScroll = hRange > 0 && isScrollAxis(el, "x");
			if (!vScroll && !hScroll) return false;

			const size = sizeRef.current;
			const vTrack = Math.max(r.height - V_EDGE_INSET * 2, 1);
			const hTrack = Math.max(r.width - H_EDGE_INSET * 2, 1);
			// Gummy's thumb is sized by the visible ratio; pac-man's is the
			// glyph itself, travelling the full track. An axis that cannot
			// scroll gets a ZERO-length thumb — the skin's default — rather
			// than a ratio-scaled stub parked at the top of the track.
			const vLen = !vScroll
				? 0
				: skinRef.current.base === "gummy"
					? clampThumb(vTrack * (el.clientHeight / Math.max(el.scrollHeight, 1)), vTrack)
					: Math.min(size, vTrack);
			// A non-overflowing axis gets a zero-length thumb, not a full-length one:
			// the visible ratio is 1 there, and a full-width bar would read as
			// "there is more to scroll sideways".
			const hLen = hScroll ? clampThumb(hTrack * (el.clientWidth / Math.max(el.scrollWidth, 1)), hTrack) : 0;

			// Everything the rail paints is derived from these numbers. If none
			// of them moved, the pass is a pure no-op: no writes, and crucially
			// `vScale` keeps the value the rail was drawn with. Re-deriving it
			// from a range that wobbled by a pixel or two is what made the thumb
			// drift under a steady scroll.
			const key = `${r.left},${r.top},${r.width},${r.height},${vRange},${hRange},${vLen},${hLen},${size},${skinRef.current.base}`;
			if (rail.measureKey === key) return true;
			const v = stackZ(el);
			rail.measureKey = key;

			rail.root.style.left = `${r.left}px`;
			rail.root.style.top = `${r.top}px`;
			rail.root.style.width = `${r.width}px`;
			rail.root.style.height = `${r.height}px`;
			rail.root.style.zIndex = String(v + 1);
			rail.vertical.style.height = `${Math.round(vLen)}px`;
			rail.horizontal.style.width = `${Math.round(hLen)}px`;
			rail.vLen = vLen;
			rail.hLen = hLen;
			rail.vTrack = vTrack;
			rail.hTrack = hTrack;
			rail.vRange = vRange;
			rail.hRange = hRange;
			rail.vScale = vScroll ? (vTrack - vLen) / vRange : 0;
			rail.hScale = hScroll ? (hTrack - hLen) / hRange : 0;
			rail.vOverflow = vScroll;
			rail.hOverflow = hScroll;
			return true;
		};

		/**
		 * Hot path. Reads `scrollTop` / `scrollLeft` and nothing else; writes
		 * `transform` and nothing else — no layout reads, no layout writes. Both
		 * offsets are read before either thumb is written.
		 *
		 * `releaseArmed` is the guard that keeps the thumb glued to the scroll
		 * offset. The release spring is a 420ms BACK-out curve (it overshoots),
		 * so leaving it armed while the position moves animates every frame's
		 * transform: the thumb trails the offset, reads as non-linear tracking,
		 * and while dragging it trails the pointer far enough that an upward
		 * drag looks like it refuses to move. Only `armSettle` — which runs once
		 * the scroll has actually stopped — arms it, and the first pass that
		 * moves the thumb again disarms it.
		 */
		const position = (rail: Rail): void => {
			const el = rail.target;
			if (!el) return;
			if (rail.releaseArmed) {
				rail.releaseArmed = false;
				rail.vertical.style.transition = "none";
			}
			if (rail.vOverflow) {
				// Sub-pixel, never rounded. A thumb travelling 68px over a 400px
				// range moves 0.17px per scroll pixel; rounding turned that into a
				// step every ~6px, which reads as dropped frames rather than
				// motion. Composited transforms take fractional offsets.
				const offset = el.scrollTop * rail.vScale;
				if (skinRef.current.base === "gummy") {
					// Squashed while the position is moving.
					rail.vertical.style.transform = `translate3d(0, ${offset}px, 0) scaleY(1.06)`;
				} else {
					// One progress scalar drives both the glyph and the eaten
					// run, so the eaten beads always end where the glyph starts.
					// They used to come from two independent formulas and drifted
					// apart on screen.
					const progress = rail.vRange > 0 ? Math.min(1, Math.max(0, el.scrollTop / rail.vRange)) : 0;
					rail.vertical.style.transform = `translate3d(0, ${offset}px, 0)`;
					if (rail.eaten) rail.eaten.style.transform = `scaleY(${progress})`;
				}
			}
			if (rail.hOverflow) {
				rail.horizontal.style.transform = `translate3d(${el.scrollLeft * rail.hScale}px, 0, 0)`;
			}
		};

		/**
		 * One moving deadline instead of clearTimeout+setTimeout per scroll
		 * event: a burst only rewrites `hideAt`, and the armed timer re-checks
		 * and re-arms itself with whatever delay remains.
		 */
		const armIdle = (rail: Rail): void => {
			if (alwaysRef.current || rail.drag || rail.overThumb || rail.overContainer) return;
			rail.hideAt = performance.now() + HIDE_MS;
			if (rail.hideTimer) return;
			const run = (): void => {
				rail.hideTimer = 0;
				if (alwaysRef.current || rail.drag || rail.overThumb || rail.overContainer) return;
				const delay = rail.hideAt - performance.now();
				if (delay > 0) {
					rail.hideTimer = window.setTimeout(run, delay);
					return;
				}
				const el = rail.target;
				if (!el) return;
				if (isGone(el) || !overflows(el)) {
					retire(el, rail);
					return;
				}
				// Idle is the drag affordance, not a dismissal: the rail fades
				// to a faint ghost whose thumbs stay grabbable. Only the SLOT is
				// eventually released, and only after the ghost has outlived any
				// plausible follow-up scroll.
				rail.root.dataset.idle = "1";
				rail.releaseAt = performance.now() + RELEASE_MS;
			};
			rail.hideTimer = window.setTimeout(run, HIDE_MS);
		};

		/** Gummy relaxes from its stretch ~140ms after scrolling stops. */
		const armSettle = (rail: Rail): void => {
			window.clearTimeout(rail.settleTimer);
			rail.settleTimer = window.setTimeout(() => {
				rail.settleTimer = 0;
				const el = rail.target;
				if (!el) return;
				if (isGone(el) || !overflows(el)) {
					retire(el, rail);
					return;
				}
				if (skinRef.current.base !== "gummy") return;
				// Never spring while the thumb is under the pointer: the release
				// animation would lag the drag instead of following it.
				if (rail.drag) return;
				// Arm the spring and drop the stretch in one animated step. The
				// flag tells `position` to disarm it before the next real move.
				rail.releaseArmed = true;
				rail.vertical.style.transition = GUMMY_RELEASE;
				rail.vertical.style.transform = `translate3d(0, ${Math.round(el.scrollTop * rail.vScale)}px, 0)`;
			}, 140);
		};

		/** Show the rail for a container, refresh its geometry and its deadline. */
		const indicate = (target: HTMLElement, rail: Rail): void => {
			if (!measure(rail)) {
				retire(target, rail);
				return;
			}
			rail.root.dataset.visible = "1";
			delete rail.root.dataset.idle;
			rail.releaseAt = 0;
			rail.lastUsed = performance.now();
			position(rail);
			armSettle(rail);
			armIdle(rail);
		};

		function onContainerEnter(this: HTMLElement, ev: Event): void {
			const rail = rails.get(this);
			if (!rail) return;
			// Mouse only: touch and pen fire pointerenter on contact, which
			// would flash a rail under every tap.
			const pointer = ev as PointerEvent;
			if (pointer.pointerType && pointer.pointerType !== "mouse") return;
			rail.overContainer = true;
			window.clearTimeout(rail.hideTimer);
			rail.hideTimer = 0;
			// A suppressed rail may hold stale geometry, so hover re-measures
			// rather than only revealing.
			indicate(this, rail);
		}

		function onContainerLeave(this: HTMLElement, ev: Event): void {
			const rail = rails.get(this);
			if (!rail) return;
			const pointer = ev as PointerEvent;
			if (pointer.pointerType && pointer.pointerType !== "mouse") return;
			rail.overContainer = false;
			armIdle(rail);
		}

		/**
		 * Queue a re-measure for the next animation frame.
		 *
		 * Observers must never measure synchronously. A virtualized transcript
		 * swaps rows and adjusts its spacer while you scroll, so both callbacks
		 * fire many times per scroll frame; measuring inline re-derived
		 * `vScale` every time, and since `vScale` divides the scroll range a
		 * range that wobbles by a few pixels moved the thumb for an unchanged
		 * `scrollTop` — the rail read as drifting and laggy, and a drag in
		 * progress disagreed with the pointer. One frame collapses the burst,
		 * and `measure` skips the write when the geometry is unchanged.
		 */
		const requestMeasure = (rail: Rail): void => {
			rail.needsMeasure = true;
			rail.dirty = true;
			scheduleUpdate();
		};

		/**
		 * Watch the container for box changes AND direct-child churn. A
		 * transcript that gains a turn, or a virtualized list that swaps rows,
		 * never resizes the scroller itself — watching only the scroller strands
		 * the rail at stale geometry. Re-observing from scratch on every change
		 * of target is what keeps a recycled slot from accumulating observers.
		 */
		/** Re-resolve the slot's LIVE elements into the rail. React replaces the
		 *  subtree when the skin changes base, so captured references go stale. */
		const rebind = (rail: Rail): void => {
			const s = slots[rail.slot];
			if (!s) return;
			rail.root = s.root ?? rail.root;
			rail.vertical = s.vertical ?? rail.vertical;
			rail.horizontal = s.horizontal ?? rail.horizontal;
			rail.eaten = s.eaten;
		};

		/** Watch the container's own box only. Watching children churned on every
		 *  virtualized row swap, and the liveness probe already catches a container
		 *  whose content stopped overflowing. */
		const reobserveChildren = (rail: Rail): void => {
			const el = rail.target;
			if (!el || !rail.resizeObserver) return;
			rail.resizeObserver.disconnect();
			rail.resizeObserver.observe(el);
		};

		const observe = (rail: Rail): void => {
			const el = rail.target;
			if (!el) return;
			if (!rail.resizeObserver) {
				rail.resizeObserver = new ResizeObserver(() => requestMeasure(rail));
			}
			reobserveChildren(rail);
			if (!rail.mutationObserver) {
				rail.mutationObserver = new MutationObserver(() => requestMeasure(rail));
			}
			rail.mutationObserver.disconnect();
			rail.mutationObserver.observe(el, { childList: true });
		};

		/** Bind a container to a slot, recycling the coldest rail when full. */
		const bind = (target: HTMLElement): Rail | null => {
			const existing = rails.get(target);
			if (existing) return existing;
			let slot = free.pop();
			if (slot === undefined) {
				let victim: Rail | null = null;
				for (const candidate of rails.values()) {
					if (!victim || candidate.lastUsed < victim.lastUsed) victim = candidate;
				}
				if (!victim?.target) return null;
				retire(victim.target, victim);
				slot = victim.slot;
			}
			const rail = mounted[slot];
			if (!rail) return null;
			// Resolve the slot's elements NOW, not from the mount-time snapshot.
			// A skin switch can happen at any time, and `mounted` still holds the
			// elements the slot had when the pool mounted — after a base change
			// those are the wrong nodes, so a freshly bound rail wrote its
			// transforms to the old skin's elements and the visible thumb never
			// moved.
			rebind(rail);
			rail.target = target;
			rail.intentAt = 0;
			rail.lastUsed = performance.now();
			rails.set(target, rail);
			observe(rail);
			target.addEventListener("pointerenter", onContainerEnter);
			target.addEventListener("pointerleave", onContainerLeave);
			return rail;
		};

		/**
		 * Coalesce the app's scroll signals into one animation frame. The frame
		 * re-reads the pool rather than capturing a target, so every container
		 * scrolled in the frame is serviced and the newest one always wins —
		 * capturing the first target of a frame left the rail indicating a
		 * container the user had already moved on from.
		 *
		 * The pass reads offsets and writes transforms only. Measuring is
		 * reserved for the paths that can actually change a box: the initial
		 * bind, resize, content mutation, hover reveal, and a skin switch
		 * (they raise `needsMeasure`).
		 */
		const scheduleUpdate = (): void => {
			if (frameRef.current) return;
			frameRef.current = window.requestAnimationFrame(() => {
				frameRef.current = 0;
				for (const [target, rail] of Array.from(rails.entries())) {
					if (!rail.target) continue;
					if (!rail.dirty && !rail.needsMeasure) continue;
					rail.dirty = false;
					if (rail.needsMeasure) {
						rail.needsMeasure = false;
						// Content that no longer overflows leaves nothing to
						// indicate — same exit as an unmounted container.
						if (!measure(rail)) {
							retire(target, rail);
							continue;
						}
					}
					position(rail);
				}
			});
		};

		/**
		 * A real gesture makes the scrolls that follow count as user intent.
		 * Recorded globally as well as per rail: the gesture lands on a
		 * container that has no rail yet, which is exactly the case where
		 * suppression must not swallow the first scroll.
		 */
		let lastIntentAt = 0;
		const markIntent = (): void => {
			const now = performance.now();
			lastIntentAt = now;
			for (const rail of rails.values()) rail.intentAt = now;
		};
		const onKeyIntent = (e: KeyboardEvent): void => {
			if (SCROLL_KEYS.has(e.key)) markIntent();
		};

		const onScroll = (e: Event): void => {
			const t = e.target;
			if (!(t instanceof HTMLElement) || t === document.documentElement) return;
			// Detached container: cheap `isConnected` check only. Whether a LIVE
			// container still overflows is settled by the periodic probe, not
			// here — a rect read per scroll frame is exactly the layout cost the
			// hot path exists to avoid.
			if (!t.isConnected) {
				const stale = rails.get(t);
				if (stale) retire(t, stale);
				return;
			}
			const existing = rails.get(t);
			if (!existing) {
				// First sighting. Only a real gesture may open a rail, in every
				// mode: programmatic motion on a never-scrolled container — a
				// virtualizer's first spacer write, a focus restore, a morph
				// height — must not flash one. Always-visible changes how long a
				// rail STAYS, never which containers get one.
				if (performance.now() - lastIntentAt > INTENT_WINDOW_MS) return;
				const rail = bind(t);
				if (!rail) return;
				// The bind measures once: nothing about this box is known yet.
				indicate(t, rail);
				return;
			}
			// Already-bound rail. It stays up for this container — the
			// gesture gate only decides whether to OPEN a rail, never whether
			// to close one that is already indicating something.
			const rail = existing;
			// Already-bound rail: geometry was resolved when it was bound, and
			// re-resolved by the resize / mutation / hover paths. A scroll frame
			// only moves the thumb — no layout read, no layout write. Many scroll
			// events in one frame collapse into a single position pass.
			rail.root.dataset.visible = "1";
			delete rail.root.dataset.idle;
			rail.releaseAt = 0;
			rail.lastUsed = performance.now();
			rail.dirty = true;
			armSettle(rail);
			armIdle(rail);
			scheduleUpdate();
		};

		const railFor = (target: EventTarget | null): Rail | null => {
			if (!(target instanceof HTMLElement)) return null;
			const root = target.closest<HTMLElement>(".gui-float-scrollbar");
			if (!root?.dataset.slot) return null;
			const rail = mounted[Number(root.dataset.slot)];
			return rail?.target ? rail : null;
		};

		const onThumbOver = (e: Event): void => {
			const rail = railFor(e.target);
			if (!rail) return;
			rail.overThumb = true;
			window.clearTimeout(rail.hideTimer);
			rail.hideTimer = 0;
		};
		const onThumbOut = (e: Event): void => {
			const rail = railFor(e.target);
			if (!rail) return;
			rail.overThumb = false;
			armIdle(rail);
		};

		// A resize changes every bound container's box at once: one flag per
		// rail, one frame, one measure each — same path the observers use.
		const onWindowResize = (): void => {
			for (const rail of rails.values()) requestMeasure(rail);
		};

		// Liveness sweep: an idle ghost has no pending event to wake it, so a
		// container that unmounted after the fade would hang over unrelated UI
		// forever (user: 会话列表的滚动条在进入设置后仍在).
		const probe = window.setInterval(() => {
			const now = performance.now();
			for (const [target, rail] of Array.from(rails.entries())) {
				if (isGone(target) || !overflows(target)) {
					retire(target, rail);
					continue;
				}
				// Free a ghost that has outlived its usefulness, so the pool
				// stays available for containers scrolled right now.
				if (rail.root.dataset.visible === "1" && rail.releaseAt > 0 && now > rail.releaseAt) {
					retire(target, rail);
				}
			}
		}, PROBE_MS);

		/**
		 * Drag either thumb. Pressing wakes the rail; the grab offset is kept so
		 * the thumb does not jump the scroll position to its centre.
		 */
		dragRef.current = (slot: number, axis: Axis, e: ReactPointerEvent<HTMLDivElement>): void => {
			const rail = mounted[slot];
			const target = rail?.target;
			if (!rail || !target) return;
			rebind(rail);
			const isVertical = axis === "v";
			e.preventDefault();
			const thumb = isVertical ? rail.vertical : rail.horizontal;
			thumb.setPointerCapture(e.pointerId);
			rail.drag = {
				axis,
				pointerId: e.pointerId,
				pointerStart: isVertical ? e.clientY : e.clientX,
				// Where the thumb sat when it was grabbed. Without this the
				// pointer delta is treated as an absolute offset, so a 1px drag
				// up slams the container to the top and a 1px drag down slams it
				// to the bottom — the thumb stops tracking the pointer entirely.
				grabOffset: isVertical ? target.scrollTop * rail.vScale : target.scrollLeft * rail.hScale,
			};
			rail.root.dataset.visible = "1";
			delete rail.root.dataset.idle;
			window.clearTimeout(rail.hideTimer);
			rail.hideTimer = 0;
			const onMove = (ev: PointerEvent): void => {
				if (!rail.drag || rail.drag.pointerId !== ev.pointerId) return;
				// Invert what `position` does: offset = scroll * scale, so
				// scroll = offset / scale. Reading the scale on every move —
				// rather than freezing range and travel at pointerdown — is what
				// keeps the thumb under the pointer when a virtualizer shifts the
				// content height mid-drag. Freezing the two made them disagree,
				// and an upward drag then read as stuck.
				const scale = isVertical ? rail.vScale : rail.hScale;
				const travel = isVertical ? rail.vTrack - rail.vLen : rail.hTrack - rail.hLen;
				if (scale <= 0 || travel <= 0) return;
				const pointer = isVertical ? ev.clientY : ev.clientX;
				const offset = Math.min(travel, Math.max(0, rail.drag.grabOffset + (pointer - rail.drag.pointerStart)));
				const scroll = offset / scale;
				if (isVertical) target.scrollTop = scroll;
				else target.scrollLeft = scroll;
			};
			const onUp = (ev: PointerEvent): void => {
				thumb.removeEventListener("pointermove", onMove);
				thumb.removeEventListener("pointerup", onUp);
				thumb.removeEventListener("pointercancel", onUp);
				if (thumb.hasPointerCapture(ev.pointerId)) thumb.releasePointerCapture(ev.pointerId);
				rail.drag = null;
				armIdle(rail);
			};
			thumb.addEventListener("pointermove", onMove);
			thumb.addEventListener("pointerup", onUp);
			thumb.addEventListener("pointercancel", onUp);
		};

		engineRef.current = { measure, position, indicate, retire, armIdle, rebind };

		window.addEventListener("scroll", onScroll, { capture: true, passive: true });
		window.addEventListener("wheel", markIntent, { capture: true, passive: true });
		window.addEventListener("touchstart", markIntent, { capture: true, passive: true });
		window.addEventListener("touchmove", markIntent, { capture: true, passive: true });
		window.addEventListener("keydown", onKeyIntent, { capture: true });
		window.addEventListener("resize", onWindowResize);
		window.addEventListener("pointerover", onThumbOver, { capture: true, passive: true });
		window.addEventListener("pointerout", onThumbOut, { capture: true, passive: true });

		return () => {
			engineRef.current = null;
			dragRef.current = null;
			window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
			window.removeEventListener("wheel", markIntent, { capture: true } as EventListenerOptions);
			window.removeEventListener("touchstart", markIntent, { capture: true } as EventListenerOptions);
			window.removeEventListener("touchmove", markIntent, { capture: true } as EventListenerOptions);
			window.removeEventListener("keydown", onKeyIntent, { capture: true } as EventListenerOptions);
			window.removeEventListener("resize", onWindowResize);
			window.removeEventListener("pointerover", onThumbOver, { capture: true } as EventListenerOptions);
			window.removeEventListener("pointerout", onThumbOut, { capture: true } as EventListenerOptions);
			window.clearInterval(probe);
			if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
			frameRef.current = 0;
			for (const [target, rail] of Array.from(rails.entries())) retire(target, rail);
		};
	}, []);

	// Always-visible mode means "a rail that is up stays up", nothing more.
	// Turning it on bypasses the idle gate for every rail that a real scroll
	// gesture has already bound; turning it off re-arms the idle deadline.
	// The hover flags are cleared on the way down because `armIdle` skips a
	// rail it believes is still hovered, and a flag left true by a
	// `pointerenter` whose `pointerleave` never arrived (pointer left the
	// window, or the container was swapped under it) would pin that rail
	// visible until the next remount. An explicit switch is stronger evidence
	// of intent than a stale hover.
	useEffect(() => {
		alwaysRef.current = alwaysShow;
		const rails = railsRef.current;
		for (const [target, rail] of Array.from(rails.entries())) {
			if (alwaysShow) {
				window.clearTimeout(rail.hideTimer);
				rail.hideTimer = 0;
				rail.intentAt = performance.now();
				engineRef.current?.indicate(target, rail);
			} else {
				rail.overThumb = false;
				rail.overContainer = false;
				engineRef.current?.armIdle(rail);
			}
		}
	}, [alwaysShow]);

	// A skin change alters thumb length (visible-ratio vs glyph) and the
	// horizontal track inset, so every bound rail is re-measured; otherwise a
	// switch would leave stale lengths and scales painted.
	useEffect(() => {
		sizeRef.current = skin.size;
		for (const rail of railsRef.current.values()) {
			// The slot's DOM was just replaced by the new base's markup, so the
			// rail's captured elements are detached.
			engineRef.current?.rebind(rail);
			rail.root.style.setProperty("--skin-accent", skin.colors.accent);
			rail.root.style.setProperty("--skin-track", skin.colors.track);
			rail.root.style.setProperty("--skin-eaten", skin.colors.eaten);
			rail.root.style.setProperty("--skin-size", `${skin.size}px`);
			rail.root.dataset.base = skin.base;
			rail.root.dataset.skin = skin.id;
			if (!engineRef.current?.measure(rail)) {
				const target = rail.target;
				if (target) engineRef.current?.retire(target, rail);
				continue;
			}
			engineRef.current?.position(rail);
		}
	}, [skin]);

	return (
		<>
			{Array.from({ length: slotCount }, (_, slot) => (
				<RailSlot key={slot} slot={slot} refs={slotsRef} skin={skin} dragRef={dragRef} />
			))}
		</>
	);
}

/** A rail slot's stable DOM. Every geometry value is written imperatively by
 *  the pool; React only supplies the elements, the skin attributes and the
 *  drag entry point. */
function RailSlot({
	slot,
	refs,
	skin,
	dragRef,
}: {
	slot: number;
	refs: MutableRefObject<RailSlotRefs[]>;
	skin: ScrollbarSkin;
	dragRef: MutableRefObject<((slot: number, axis: Axis, e: ReactPointerEvent<HTMLDivElement>) => void) | null>;
}): ReactNode {
	const entry = refs.current[slot];
	return (
		<div
			ref={el => {
				entry.root = el;
			}}
			className="gui-float-scrollbar"
			data-base={skin.base}
			data-skin={skin.id}
			data-slot={String(slot)}
			aria-hidden="true"
			style={
				{
					"--skin-accent": skin.colors.accent,
					"--skin-track": skin.colors.track,
					"--skin-eaten": skin.colors.eaten,
					"--skin-size": `${skin.size}px`,
				} as CSSProperties
			}
		>
			{skin.base === "gummy" ? (
				<>
					<div
						ref={el => {
							entry.vertical = el;
						}}
						className="gfs-v"
						onPointerDown={e => dragRef.current?.(slot, "v", e)}
					>
						<span className="gfs-gummy-shine" />
					</div>
					<div
						ref={el => {
							entry.horizontal = el;
						}}
						className="gfs-h"
						onPointerDown={e => dragRef.current?.(slot, "h", e)}
					/>
				</>
			) : (
				<>
					<div className="gfs-track" />
					<div className="gfs-beads" />
					<div
						ref={el => {
							entry.eaten = el;
						}}
						className="gfs-beads-eaten"
					/>
					<div
						ref={el => {
							entry.vertical = el;
						}}
						className="gfs-pac"
						onPointerDown={e => dragRef.current?.(slot, "v", e)}
					>
						{skin.pacGlyph ? (
							<img src={skin.pacGlyph} alt="" width={skin.size} height={skin.size} />
						) : (
							<PacMan size={skin.size} side="down" animating />
						)}
					</div>
					<div
						ref={el => {
							entry.horizontal = el;
						}}
						className="gfs-h"
						onPointerDown={e => dragRef.current?.(slot, "h", e)}
					/>
				</>
			)}
		</div>
	);
}
