import { type CSSProperties, type RefObject, useEffect, useRef } from "react";

/**
 * Collapse/expand height animation for conditionally-visible bodies.
 *
 * Height is driven through the `--h` CSS custom property (component CSS maps
 * `height: var(--h, 0px)` with a transition), so:
 * - the body stays mounted and both directions animate (grid-template-rows
 *   0fr↔1fr snaps in Chromium; unmount-based collapse cannot animate);
 * - padding/border never jump — only `height` transitions;
 * - `auto` is restored once an expand settles, so streaming content keeps
 *   its natural height.
 * First render lands directly at the open/closed state (no flash, no jump).
 */
export interface CollapseHeightOptions {
	/** Transition duration in ms (default 220). */
	durationMs?: number;
	/** Height the closed body settles at when it collapses to a visible
	 *  preview (e.g. a 2-line clamp) instead of 0. Measured by the caller
	 *  while the preview is mounted — the hook runs after the DOM already
	 *  switched sides, so a live read there would see the other state. */
	closedHeight?: () => number;
	/** Fires once the height transition finishes, both directions (a
	 *  collapse with `closedHeight` fires before the caller may re-apply
	 *  the collapsed visual, e.g. a clamp class). */
	onSettled?: (open: boolean) => void;
}

export function useCollapseHeight(
	open: boolean,
	ref: RefObject<HTMLDivElement | null>,
	opts: CollapseHeightOptions = {},
): void {
	const durationMs = opts.durationMs ?? 220;
	// Latest-ref: callers pass inline closures; the effect must not re-run
	// (and restart a running transition) whenever the parent re-renders.
	const optsRef = useRef(opts);
	useEffect(() => {
		optsRef.current = opts;
	});
	const animVer = useRef(0);
	// The state the last setup ran for. An effect can be cleaned up while its
	// DOM survives and then replayed on reveal (StrictMode's double invoke, a
	// suspense boundary revealing, a virtualizer re-mounting the row): the
	// previous run's animation was cancelled but this ref still records its
	// target. Without the short-circuit below, the replayed setup would take the
	// measure branch and pin the CURRENT rendered height — which on a collapsed
	// element is the collapsed one — leaving a blank region at the old height.
	//
	// Seeded with `open`, which also covers the first mount: it lands directly on
	// the target with no measure and no animation, so no separate `first` flag
	// is needed.
	const previous = useRef(open);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const closed = optsRef.current.closedHeight;
		const setH = (v: string): void => el.style.setProperty("--h", v);
		// Claim this run's version immediately: `settle` below ignores a call
		// from a superseded run, so a stale `transitionend` (from the animation
		// this run may cancel) cannot land on the new state.
		const ver = animVer.current + 1;
		animVer.current = ver;
		let done = false;
		const settle = (isOpen: boolean): void => {
			if (done || animVer.current !== ver) return;
			done = true;
			// Expand settles to auto so streamed content keeps its natural
			// height; a collapse keeps its target (0px, or the preview px —
			// the caller's re-applied clamp bounds height via CSS, and an
			// intermediate auto on the still-unclamped body would paint one
			// full-height frame).
			if (isOpen) setH("auto");
			else if (closed) setH(`${closed()}px`);
			optsRef.current.onSettled?.(isOpen);
		};
		if (previous.current === open) {
			// Nothing changed since the last setup: settle onto the target instead
			// of measuring. Covers both the first mount and an effect replay.
			// Settling (not just writing the closed value) matters after an
			// expand — a body left pinned at a measured pixel height stops
			// growing, so streamed content would be clipped for the rest of the
			// turn.
			settle(open);
			return;
		}
		previous.current = open;
		const to = closed ? `${closed()}px` : "0px";
		if (open) {
			setH(to);
			void el.offsetHeight;
			setH(`${el.scrollHeight}px`);
		} else {
			// Collapse: pin the current rendered height, then shrink to the
			// closed height.
			setH(`${el.scrollHeight}px`);
			void el.offsetHeight;
			setH(to);
		}
		el.addEventListener("transitionend", () => settle(open), { once: true });
		setTimeout(() => settle(open), durationMs + 30);
	}, [open, ref, durationMs]);
}

/** Initial inline --h so first paint already matches the open state. */
export function collapseStyle(open: boolean): CSSProperties {
	return { "--h": open ? "auto" : "0px" } as CSSProperties;
}
