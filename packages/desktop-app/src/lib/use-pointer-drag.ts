import { type PointerEvent as ReactPointerEvent, useRef } from "react";

/**
 * 归一化拖拽 primitive — the one pointer-drag contract for the GUI.
 *
 * Replaces the ad-hoc drag implementations that kept re-appearing with the
 * same bug class: window-level pointermove/pointerup listeners (no pointer
 * capture → listeners leak when the pointer leaves the window, state sticks
 * after a cancelled gesture) and no click-vs-drag threshold (drag-then-click
 * misfires). This hook gives every drag site one lifecycle:
 *
 *   pointerdown (captured) → [threshold crossed] → dragStart → dragMove* →
 *   dragEnd | tap
 *
 * Callers spread the returned handlers onto the drag surface and use
 * `touch-action: none` (inline style or CSS class) so touch gestures don't
 * scroll instead of dragging. Interactive children (buttons) stop
 * propagation on pointerdown to exclude themselves from the gesture.
 */

export interface PointerDragStartContext {
	element: HTMLElement;
	pointerId: number;
	startX: number;
	startY: number;
}

export interface PointerDragMoveContext {
	/** Total travel from the start point (not per-event delta). */
	dx: number;
	dy: number;
	/** Current pointer position (client coords). */
	x: number;
	y: number;
	startX: number;
	startY: number;
}

export interface PointerDragEndContext {
	/** Whether the gesture crossed the threshold (a real drag, not a tap). */
	dragged: boolean;
	dx: number;
	dy: number;
}

export interface PointerDragOptions {
	/** Fired once when the pointer travels past `threshold`. */
	onDragStart?(ctx: PointerDragStartContext): void;
	onDragMove?(ctx: PointerDragMoveContext): void;
	/** Fired on pointerup/pointercancel for REAL drags (threshold crossed);
	 *  taps (no threshold) fire `onTap` instead — never both. */
	onDragEnd?(ctx: PointerDragEndContext): void;
	/** Tap (no threshold crossed) — use INSTEAD of the element's onClick so
	 *  a drag ending on the element can never also fire a click. */
	onTap?(): void;
	/** Minimum pointer travel (px) before the gesture counts as a drag. */
	threshold?: number;
}

export interface PointerDragHandlers {
	onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
	onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
	onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
	onPointerCancel(e: ReactPointerEvent<HTMLElement>): void;
}

export function usePointerDrag({
	onDragStart,
	onDragMove,
	onDragEnd,
	onTap,
	threshold = 4,
}: PointerDragOptions): PointerDragHandlers {
	// Callbacks ride a ref so the handlers never capture a stale render.
	const cb = useRef({ onDragStart, onDragMove, onDragEnd, onTap });
	cb.current = { onDragStart, onDragMove, onDragEnd, onTap };
	const state = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		x: number;
		y: number;
		element: HTMLElement;
		dragged: boolean;
	} | null>(null);

	const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
		// Primary button only; ignore pen eraser / secondary gestures.
		if (e.button !== 0) return;
		const el = e.currentTarget;
		state.current = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			x: e.clientX,
			y: e.clientY,
			element: el,
			dragged: false,
		};
		// Capture: move/up/cancel keep targeting this element even when the
		// pointer leaves the window — no window listeners, nothing to leak.
		el.setPointerCapture(e.pointerId);
	};

	const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
		const s = state.current;
		if (!s || s.pointerId !== e.pointerId) return;
		s.x = e.clientX;
		s.y = e.clientY;
		const dx = s.x - s.startX;
		const dy = s.y - s.startY;
		if (!s.dragged) {
			if (Math.hypot(dx, dy) < threshold) return;
			s.dragged = true;
			// Once it's a drag, suppress native selection/gestures.
			e.preventDefault();
			cb.current.onDragStart?.({
				element: s.element,
				pointerId: s.pointerId,
				startX: s.startX,
				startY: s.startY,
			});
		}
		cb.current.onDragMove?.({ dx, dy, x: s.x, y: s.y, startX: s.startX, startY: s.startY });
	};

	const finish = (e: ReactPointerEvent<HTMLElement>): void => {
		const s = state.current;
		if (!s || s.pointerId !== e.pointerId) return;
		state.current = null;
		if (s.element.hasPointerCapture(e.pointerId)) s.element.releasePointerCapture(e.pointerId);
		if (s.dragged) {
			cb.current.onDragEnd?.({ dragged: true, dx: s.x - s.startX, dy: s.y - s.startY });
		} else {
			cb.current.onTap?.();
		}
	};

	return {
		onPointerDown,
		onPointerMove,
		onPointerUp: finish,
		onPointerCancel: finish,
	};
}
