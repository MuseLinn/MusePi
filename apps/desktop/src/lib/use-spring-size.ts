import { animateSpring, type SpringConfig, type SpringOptions } from "@musepi/client-core";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drive a DOM element's size (and anything else derived from it) with a
 * spring.
 *
 * The reason this exists instead of a CSS transition: a surface that morphs
 * between two shapes — a pill that becomes a field — needs its overshoot and
 * its settle time to be stated as spring parameters, not as a cubic-bezier
 * fitted by eye. A bezier has to be a function of time, so it cannot say
 * "feels settled at 440ms" and "overshoots by 22% of the travel"; a spring
 * says both, and the same parameters then drive width, height and radius
 * together without each needing its own curve.
 *
 * The element's width and height are written directly (no transition), and
 * `onFrame` receives the sampled progress so a caller can derive other
 * properties — an opacity that must finish with the size change, say — from
 * the SAME spring instead of running a second animation beside it.
 *
 * Reduced motion (the app's `gui-motion-off` class or the OS setting) lands
 * on the target immediately: the shape still changes, it just does not move
 * through the intermediate sizes.
 */
export function useSpringSize(options: {
	/** Current target: the shape to hold when idle. */
	expanded: boolean;
	/** Width of the collapsed shape, px. Optional: when omitted, the
	 *  collapsed width is MEASURED from the element's own content, which is
	 *  what a content-sized row needs — a hard-coded number is off by a few
	 *  pixels as soon as the content changes, and the mismatch shows as the
	 *  surface shrinking before it grows. */
	collapsedWidth?: number;
	/** Width of the expanded shape, px. */
	expandedWidth: number;
	/** Height of the collapsed shape, px. Optional — measured when omitted. */
	collapsedHeight?: number;
	/** Height of the expanded shape, px. */
	expandedHeight: number;
	/** Spring parameters. */
	spring?: SpringConfig;
	/** Called every frame with the sampled progress (0 = collapsed, 1 = expanded). */
	onFrame?: (progress: number) => void;
	/** Called once the animation has finished. */
	onDone?: () => void;
}): {
	/** Attach to the element to size. */
	ref: (element: HTMLDivElement | null) => void;
	/** Imperatively drive the element to a shape. */
	animateTo: (expanded: boolean) => void;
	/** Stop any running animation, leaving the element where it is. */
	stop: () => void;
} {
	const { expanded, collapsedWidth, expandedWidth, collapsedHeight, expandedHeight } = options;
	const stopRef = useRef<(() => void) | null>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	// The element arrives as a REF, not as a prop: a ref's `.current` is null
	// on the first render and never triggers a re-render, so passing it
	// straight through would leave the spring with no element to size. The
	// callback ref is what turns the mount into a render.
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const ref = useCallback((element: HTMLDivElement | null): void => setNode(element), []);
	/** The element's content size, measured once. See {@link measureContent}. */
	const contentSizeRef = useRef<{ width: number; height: number } | null>(null);
	/** The size the surface was last written to — see {@link write}. */
	const lastSizeRef = useRef<{ width: number; height: number } | null>(null);
	/** The size the surface is heading to — guards against restarting the
	 *  spring for a target it is already travelling towards. */
	const targetRef = useRef<{ width: number; height: number } | null>(null);

	const write = useCallback(
		(width: number | null, height: number | null): void => {
			if (!node) return;
			// A null size means "let the content decide". The collapsed row is
			// content-sized — three buttons, two hairlines, the gaps — so
			// pinning a width on it would fight the content it is made of.
			node.style.width = width === null ? "" : `${width}px`;
			node.style.height = height === null ? "" : `${height}px`;
			// Remember where the surface is. The NEXT morph starts from HERE,
			// not from what the DOM reports: by the time the effect for a new
			// target runs, React has already applied the new state's class,
			// and any CSS width on that class is the TARGET — reading it would
			// make the spring animate from the target to the target, which
			// looks like no animation at all.
			lastSizeRef.current = {
				width: width ?? node.getBoundingClientRect().width,
				height: height ?? node.getBoundingClientRect().height,
			};
		},
		[node],
	);

	/**
	 * The element's CONTENT width — what it would be with no width set.
	 *
	 * The spring writes an explicit width, so `offsetWidth` afterwards is
	 * that written width, not the content's. Measuring the content needs
	 * the written width lifted for the duration of the measurement: a row
	 * whose collapsed shape is its content must start from the content's
	 * width, or the spring animates from a start that was never on screen.
	 *
	 * The element is made INVISIBLE for the measurement rather than merely
	 * resized: clearing the width reflows the row, and a frame sampled
	 * during that reflow would catch the row at its content width — a
	 * visible one-frame jump the eye reads as a flicker.
	 */
	const measureContent = useCallback((): { width: number; height: number } => {
		if (!node) return { width: 0, height: 0 };
		const previousWidth = node.style.width;
		const previousHeight = node.style.height;
		const previousVisibility = node.style.visibility;
		node.style.visibility = "hidden";
		node.style.width = "";
		node.style.height = "";
		const size = { width: node.offsetWidth, height: node.offsetHeight };
		node.style.width = previousWidth;
		node.style.height = previousHeight;
		node.style.visibility = previousVisibility;
		return size;
	}, [node]);

	// Measure the content size once, as soon as the element exists and
	// BEFORE anything is written to it. Measuring later needs the written
	// width lifted, and that reflows the row for a frame — a sample taken
	// during the reflow catches the row at a width it was never shown at,
	// which reads as a one-frame flicker.
	useEffect(() => {
		if (!node) return;
		contentSizeRef.current = measureContent();
	}, [node, measureContent]);

	const animateTo = useCallback(
		(nextExpanded: boolean): void => {
			const current = optionsRef.current;
			const el = node;
			if (!el) return;
			// The content size is measured ONCE, when the element mounts, and
			// cached. Measuring it later needs the written width lifted, and
			// that reflows the row — a frame sampled during the reflow
			// catches the row at a width it was never shown at, which reads
			// as a one-frame flicker.
			const content = contentSizeRef.current ?? { width: 0, height: 0 };
			// The collapsed target is the CONTENT width, measured with the
			// written width lifted. A row whose collapsed shape is its own
			// content must settle at that content's width; settling at a
			// different one leaves the surface visibly off its own padding.
			// `null` means "let the content decide" — the spring still runs
			// (the shape has to travel), but the final size is left to CSS.
			const toWidth = nextExpanded ? current.expandedWidth : (current.collapsedWidth ?? null);
			const toHeight = nextExpanded ? current.expandedHeight : (current.collapsedHeight ?? null);
			const settleWidth = toWidth ?? content.width;
			const settleHeight = toHeight ?? content.height;
			if (
				targetRef.current &&
				targetRef.current.width === settleWidth &&
				targetRef.current.height === settleHeight
			) {
				return;
			}
			targetRef.current = { width: settleWidth, height: settleHeight };

			stopRef.current?.();
			stopRef.current = null;
			const remembered = lastSizeRef.current;
			const fallbackWidth = nextExpanded ? (current.collapsedWidth ?? content.width) : current.expandedWidth;
			const fallbackHeight = nextExpanded ? (current.collapsedHeight ?? content.height) : current.expandedHeight;
			const fromWidth = remembered?.width || content.width || fallbackWidth;
			const fromHeight = remembered?.height || content.height || fallbackHeight;

			const motionOff =
				document.documentElement.classList.contains("gui-motion-off") ||
				window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			if (motionOff) {
				write(toWidth, toHeight);
				current.onFrame?.(nextExpanded ? 1 : 0);
				current.onDone?.();
				return;
			}

			const spring: SpringOptions = {
				from: 0,
				to: 1,
				visualDuration: current.spring?.visualDuration ?? 0.44,
				bounce: current.spring?.bounce ?? 0.22,
				stiffness: current.spring?.stiffness,
				damping: current.spring?.damping,
				mass: current.spring?.mass,
			};
			stopRef.current = animateSpring(
				spring,
				(progress: number) => {
					// The size follows the spring's RAW progress, including the
					// overshoot past 1. Clamping it would remove exactly what
					// makes a spring a spring: the surface should swell past
					// its target and settle back, which is what tells the eye
					// that a shape changed rather than a value was assigned.
					write(
						Math.round(fromWidth + (settleWidth - fromWidth) * progress),
						Math.round(fromHeight + (settleHeight - fromHeight) * progress),
					);
					current.onFrame?.(progress);
				},
				() => {
					// Settle on the exact target. For a content-sized shape
					// that means handing the size BACK to the content, so the
					// row is its own width again rather than a pinned number
					// that happens to match today.
					write(toWidth, toHeight);
					current.onDone?.();
				},
			);
		},
		[write, node, measureContent],
	);

	const stop = useCallback((): void => {
		stopRef.current?.();
		stopRef.current = null;
	}, []);

	// The element or the target changing re-runs the animation from wherever
	// the surface currently is — so a morph interrupted mid-flight continues
	// from its current size instead of jumping.
	//
	// `animateTo` is in the dependency list on purpose: it closes over the
	// element, and a stale copy of it would be the one holding a null
	// element — the animation would then silently do nothing.
	useEffect(() => {
		animateTo(expanded);
		return () => {
			stopRef.current?.();
			stopRef.current = null;
		};
	}, [animateTo, expanded, collapsedWidth, expandedWidth, collapsedHeight, expandedHeight]);

	return { ref, animateTo, stop };
}
