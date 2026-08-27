import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const CLOSE_MS = 130;

// Module-level menu mutex: at most one floating menu may be open at a
// time. The composer's model + thinking selectors each own their open
// state, and there is no click-outside handler — without this, clicking
// the second anchor left both menus on screen. Opening one closes the
// previously-open instance (which still plays its exit fade).
let activeMenu: { close(): void } | null = null;

/**
 * Fixed-position floating menu anchored to a button (openchamber/radix
 * semantics): rendered through a portal into document.body so no ancestor's
 * overflow-hidden / backdrop-filter / transform can clip or misplace it —
 * that was the cause of the clipped dropdowns inside the welcome composer
 * and the chat surface. Opens upward when there is more room above the
 * anchor, else downward. Enter/exit both animate (gui-menu-in / -out); the
 * exit keeps the menu mounted for CLOSE_MS so the fade can play.
 *
 * Enter uses a two-phase mount: the popup first paints at opacity 0 WITHOUT
 * the animation class, then requestAnimationFrame adds it. Chromium applies
 * backdrop-filter only after the element settles, so animating opacity on
 * the very first frame made frosted menus flash transparent → suddenly
 * glassy; the pre-paint lets the blur layer composite before the fade.
 *
 * Card-surface ownership: the `className` option lands on THIS wrapper.
 * Menus that pass one (gui-proj-menu, gui-todo-popup, …) render plain
 * content; panels that are self-contained cards (gui-quota-panel,
 * gui-color-picker) must NOT pass a className and carry their surface on
 * the inner root. Applying the same card class to BOTH layers double-draws
 * the rounded frosted container (nested glass boxes behind the content).
 */
/** A point anchor (right-click coordinates): a zero-size rect at (x,y). */
export interface MenuPoint {
	x: number;
	y: number;
}

export function useFloatingMenu(
	open: boolean,
	onOpenChange?: (open: boolean) => void,
	options?: { className?: string; align?: "left" | "right"; anchor?: HTMLElement | MenuPoint | null },
): {
	anchorRef: (el: HTMLElement | null) => void;
	renderMenu(children: ReactNode): ReactNode;
} {
	const { className = "gui-menu-popup", align = "left", anchor: anchorOption } = options ?? {};
	const anchorRef = useRef<HTMLElement | null>(null);
	const setAnchor = (el: HTMLElement | null): void => {
		anchorRef.current = el;
	};
	// Portal container element — measured after first mount so horizontal
	// clamping uses the REAL menu width instead of the estimate below
	// (Base-UI/floating-ui flip+shift parity, hand-rolled).
	const menuRef = useRef<HTMLDivElement | null>(null);
	const measuredRef = useRef(false);
	// Declarative anchor (Pop parity): an element passed straight in beats
	// the imperative callback ref — read at positioning time so the layout
	// effect below sees it on the SAME commit the menu opens. A point
	// anchor (ContextMenu parity) positions at the pointer instead.
	const anchorEl = anchorOption instanceof HTMLElement ? anchorOption : anchorRef.current;
	const [pos, setPos] = useState<{ left?: number; right?: number; top?: number; bottom?: number; up: boolean } | null>(null);
	const [closing, setClosing] = useState(false);
	const [entered, setEntered] = useState(false);
	// Latest close callback without re-running the mutex effect.
	const closeRef = useRef<() => void>(() => {});
	closeRef.current = () => onOpenChange?.(false);

	// Viewport padding so a clamped menu never touches the window edge.
	const MENU_EDGE_PAD = 8;
	// Width/height assumed on the very first open (menu not mounted yet);
	// snapped to the real offsetWidth/offsetHeight on the next frame (see
	// re-measure effect below).
	const MENU_ESTIMATED_W = 260;
	const MENU_ESTIMATED_H = 300;
	const positionMenu = (): void => {
		const anchor = anchorOption ?? anchorRef.current;
		if (!anchor) return;
		// Point anchors (right-click menus) are a zero-size rect at (x,y);
		// element anchors use their layout box.
		const r =
			anchor instanceof HTMLElement
				? anchor.getBoundingClientRect()
				: { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y, width: 0, height: 0 };
		const menuW = menuRef.current?.offsetWidth ?? MENU_ESTIMATED_W;
		const menuH = menuRef.current?.offsetHeight ?? MENU_ESTIMATED_H;
		// Flip up when the menu would overflow the viewport bottom (top +
		// height > innerHeight) as well as when there is simply more room
		// above — a tall menu near the bottom edge must not clip (Base-UI
		// flip parity for the vertical axis).
		const flipUpForBottomOverflow = r.bottom + 6 + menuH > window.innerHeight - MENU_EDGE_PAD;
		const roomAbove = r.top;
		const roomBelow = window.innerHeight - r.bottom;
		const up = flipUpForBottomOverflow || (roomAbove > roomBelow);
		// Align: right -> menu's right edge on anchor's right edge; left ->
		// menu's left edge on anchor's left edge. Then CLAMP horizontally into
		// the viewport — the previous anchor-only clamp (right: innerWidth -
		// r.right) pushed menus past the LESS-visible edge: an overlay opened
		// on the far-left header got clipped by the window edge.
		const rawLeft = align === "right" ? r.right - menuW : r.left;
		const left = Math.min(
			Math.max(rawLeft, MENU_EDGE_PAD),
			Math.max(MENU_EDGE_PAD, window.innerWidth - menuW - MENU_EDGE_PAD),
		);
		setClosing(false);
		setEntered(false);
		setPos({ left, ...(!up ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }), up });
	};
	useLayoutEffect(() => {
		if (!open) {
			measuredRef.current = false;
			return;
		}
		positionMenu();
	}, [open, align]);

	// Re-position on scroll/resize: an anchor inside a scrolling container
	// (settings provider cards, onboarding provider list) moves with the
	// container; without this the menu stays at its open-time viewport
	// position — the anchor scrolls away and the menu reads as floating
	// over unrelated content ("被界面挡住" reports). Capture-phase scroll
	// so container scrolls that don't bubble (overflow-y auto) still fire.
	useEffect(() => {
		if (!open) return;
		positionMenu();
		const onScroll = (): void => positionMenu();
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		return () => {
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
		};
	}, [open, align, anchorOption]);

	// One-shot re-measure: first positioning ran before the portal existed
	// (estimated width) — after mount, snap left/right to the real menu
	// width so right-aligned menus keep their right edge ON the anchor.
	useLayoutEffect(() => {
		if (!open || !pos || measuredRef.current) return;
		if (!menuRef.current) return;
		measuredRef.current = true;
		positionMenu();
	}, [open, pos]);

	// Two-phase enter: paint at opacity 0, then start the fade next frame so
	// the frosted backdrop is ready before it becomes visible.
	useLayoutEffect(() => {
		if (!open || !pos) return;
		const id = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
		return () => cancelAnimationFrame(id);
	}, [open, pos]);

	// Animated exit: when open flips false, mark closing, unmount after the
	// fade-out duration (re-entering while closing aborts the timer).
	useEffect(() => {
		if (open) {
			setClosing(false);
			return;
		}
		if (!pos) return;
		setClosing(true);
		const id = setTimeout(() => setPos(null), CLOSE_MS);
		return () => clearTimeout(id);
	}, [open, pos]);

	// Close the menu when the window resizes away from the anchor.
	useEffect(() => {
		if (!open) return;
		const onResize = (): void => setPos(null);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [open]);

	// Unified dismissal (single implementation for every floating menu):
	// outside mousedown (the anchor toggles itself via its own onClick, so
	// clicks ON it stay) and Escape both close. Callers previously wrote
	// per-menu document listeners — some with Escape, some without — so the
	// behavior drifted; this is the one place it lives now.
	useEffect(() => {
		if (!open) return;
		const close = (): void => onOpenChange?.(false);
		const onDocDown = (e: MouseEvent): void => {
			const path = e.composedPath();
			const el = anchorEl;
			if (
				path.some(
					n =>
						n instanceof HTMLElement &&
						(n.classList?.contains("gui-menu-popup") || (el !== null && (n === el || el.contains(n)))),
				)
			) {
				return;
			}
			close();
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") close();
		};
		document.addEventListener("mousedown", onDocDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDocDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, onOpenChange, anchorEl]);

	// Global mutex: opening this menu closes whatever else is open
	// (model selector vs thinking selector, slash menu vs insert menu…).
	useEffect(() => {
		if (!open) return;
		activeMenu?.close();
		const mine = { close: () => closeRef.current() };
		activeMenu = mine;
		return () => {
			if (activeMenu === mine) activeMenu = null;
		};
	}, [open]);

	const renderMenu = (children: ReactNode): ReactNode => {
		if (!pos) return null;
		return createPortal(
			<div
				ref={menuRef}
				data-header-menu=""
				className={`gui-menu-popup ${className}${closing ? " gui-menu-popup--closing" : ""}${!closing && entered ? " gui-menu-popup--entered" : ""}`}
				style={{
					// Inline position wins over the menu-specific classes
					// (gui-creds-menu etc. declare position:absolute + top/right
					// for their legacy inline mode — the portal container must
					// stay fixed). Every offset is set explicitly so a class's
					// static top/right/bottom cannot leak: for position:fixed a
					// `100%` top resolves to the viewport height, which pushed
					// upward-opening menus off-screen (gui-creds-menu bug).
					position: "fixed",
					left: pos.left ?? "auto",
					right: pos.right ?? "auto",
					top: pos.top ?? "auto",
					bottom: pos.bottom ?? "auto",
					transformOrigin: align === "right" ? (pos.up ? "bottom right" : "top right") : pos.up ? "bottom left" : "top left",
				}}
			>
				{children}
			</div>,
			/* Portal INSIDE the React root (sibling of gui-shell, so no ancestor
			 * clips it) rather than document.body: React's delegated listeners
			 * live on the root container, and a body-level portal never bubbles
			 * through it — menu-item clicks silently died. */
			document.getElementById("root") ?? document.body,
		);
	};

	return { anchorRef: setAnchor, renderMenu };
}
