import { animateSpring, type SpringOptions } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";

/** The fade that rides along with the morph — unchanged from the CSS
 *  version, and still the container's own `gui-morph-fade` animation. */
const FADE_ANIM = "gui-morph-fade-in 160ms ease";

/**
 * The spring's settle time, in seconds.
 *
 * A spring's settle is a FEELING, not a formula: the old implementation
 * scaled a transition's duration with the height delta because a fixed
 * 240ms read as a fast pop on a large expansion (the ease-out curve
 * front-loads, so the whole height arrives in the first third and the rest
 * is dead time). A spring does not have that problem — it spends its time
 * where the motion is — so the duration stays constant and the OVERSHOOT
 * carries the character instead.
 *
 * 0.32s is the same beat as the old 240ms with a snappier tail.
 */
const MORPH_SETTLE_S = 0.32;

/**
 * Overshoot, as a fraction of the height the morph travels.
 *
 * It scales DOWN with the distance: a 20px row that overshoots by 20%
 * bounces 4px, which reads as a wobble; a 400px panel that overshoots by
 * 20% bounces 80px, which reads as a mistake. The old curve had no
 * overshoot at all, so anything here is new — keeping it small and
 * distance-proportional is what makes it read as "this has weight" rather
 * than "this is broken".
 *
 * The 4px floor: below that the overshoot is not perceptible anyway, and a
 * spring that overshoots by less than a pixel is just a slower curve.
 *
 * The fraction AND the distance are both capped, so the overshoot in PIXELS
 * — what the eye actually judges — stays within a readable band. A 20px row
 * swells 2px; an 800px panel swells at most 12px. Uncapped, the same
 * fraction would swell it 32px, which reads as the panel bouncing rather
 * than settling.
 */
export function morphBounce(delta: number): number {
	const fraction = Math.max(0.04, Math.min(0.12, 6 / Math.max(24, delta)));
	// Cap the overshoot in pixels as well: a large travel must not turn a
	// 4% overshoot into a visible bounce.
	return Math.min(fraction, 12 / Math.max(24, delta));
}

/** The motion is skipped entirely under reduced motion — the app's
 *  `gui-motion-off` class or the OS setting. The height still changes; it
 *  just arrives without travelling. */
function motionIsOff(): boolean {
	return (
		document.documentElement.classList.contains("gui-motion-off") ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * 高度形变动效规范 (height-morph standard) — for content that STAYS mounted
 * but changes height when `morphKey` changes: tab bodies with different
 * heights, in-place list growth (the providers "show all" toggle), etc.
 *
 * Mechanism: the pre-commit height is captured during render (ref read —
 * the DOM still shows the OLD content), the new content commits, then the
 * container springs old → new and settles back to auto so later changes
 * re-flow freely. The same element carries the 160ms fade-in, restarted
 * per morphKey.
 *
 * Why a spring and not a transition: a transition is a curve over TIME, so
 * it can only say how long the move takes — every intermediate height is
 * fixed by the curve, and the motion arrives "correctly" rather than
 * naturally. A spring says how far past the target the surface goes and
 * how long until it feels settled, which is what makes a surface that
 * changes shape read as a physical thing rather than as a value that was
 * assigned. The parameters are the shared spring resource
 * (`client-core/lib/spring-motion`), so every morph in the app lands on
 * the same feel.
 *
 * CRITICAL: children are rendered DIRECTLY into the container (no wrapper
 * div) — callers pass their own layout class (e.g. a CSS grid like
 * .gui-provider-grid) and a wrapper would collapse it to one grid item.
 *
 * For blocks that hide/show entirely use Reveal instead.
 */
export function HeightMorph({
	morphKey,
	className,
	children,
	innerRef,
	fade = true,
}: {
	/** Value whose change triggers the morph (tab id, toggle state, …). */
	morphKey: unknown;
	className?: string;
	children: ReactNode;
	/** Extra ref for the morph container (e.g. a scroll-shadow observer on
	 *  a fixed-height scroll container that HeightMorph itself owns). */
	innerRef?: React.Ref<HTMLDivElement>;
	/** Restart the container fade on each morph. Turn off when the children
	 *  carry their own enter/exit animation — a second container fade would
	 *  blink the still-visible items (e.g. the chip row's blur-in stagger). */
	fade?: boolean;
}): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	const prevKey = useRef(morphKey);
	const prevHeight = useRef(0);
	/** True while a morph is in flight. */
	const morphing = useRef(false);
	const el = ref.current;
	// Capture the pre-commit height during render — the DOM still shows the
	// OLD content. NOT while a morph is running: then the DOM height is an
	// intermediate value, and reading it would make the NEXT morph start
	// from a height that was only ever on screen for a frame.
	if (el && !morphing.current) prevHeight.current = el.getBoundingClientRect().height;
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node || prevKey.current === morphKey) return;
		prevKey.current = morphKey;
		if (fade) {
			// Restart the fade (the CSS animation ran once on mount).
			node.style.animation = "none";
			void node.offsetHeight;
			node.style.animation = FADE_ANIM;
		}
		// Release anything an INTERRUPTED morph pinned BEFORE measuring:
		// a stale inline height makes offsetHeight read the clip, not the
		// content, so the run would "animate" to the very clip that is
		// stuck (observed as the provider grid frozen mid-card after a
		// quick 显示全部 ⇄ 折叠 round trip).
		node.style.transition = "none";
		node.style.height = "";
		node.style.overflow = "";
		void node.offsetHeight;
		const target = node.offsetHeight;
		const delta = Math.abs(target - prevHeight.current);
		// Height unchanged (fixed-height scroll containers like the
		// settings content whose sections scroll INSIDE): nothing to
		// morph — pinning/clipping would hide the scrollbar and disable
		// scrolling for the whole transition window. Keep only the fade.
		if (delta < 1) return;
		const from = prevHeight.current;
		if (motionIsOff()) {
			// The height still changes; it just arrives without travelling.
			node.style.height = "";
			node.style.overflow = "";
			return;
		}
		morphing.current = true;
		node.style.transition = "none";
		node.style.height = `${from}px`;
		// CRITICAL: clip the new content during the morph — without
		// overflow:hidden the content renders at its natural height the
		// instant the commit lands (it overflows the pinned box and pops
		// in), so only the invisible box edge moves and the unfold reads
		// as "no animation". Clipping makes it unfold with the box.
		node.style.overflow = "hidden";
		void node.offsetHeight;

		const spring: SpringOptions = {
			from: 0,
			to: 1,
			visualDuration: MORPH_SETTLE_S,
			bounce: morphBounce(delta),
			// The spring's own cap is 4s — a runaway guard, not a settle
			// time. A morph that converges in 320ms must RELEASE the pin
			// then, not four seconds later: while the height is pinned the
			// content is clipped and cannot scroll.
			maxDuration: MORPH_SETTLE_S * 3,
		};
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			// Stop the spring: a frame that lands after the release would
			// write the height back and re-pin the container.
			stop?.();
			morphing.current = false;
			node.style.height = "";
			node.style.transition = "";
			node.style.overflow = "";
		};
		let stop: (() => void) | undefined;
		stop = animateSpring(
			spring,
			(progress: number, _elapsed: number, velocity: number) => {
				// The height follows the spring's RAW progress, including the
				// overshoot past 1 — that overshoot IS the morph. The
				// container is clipped, so a height past the target simply
				// means the box is taller than its content for a moment;
				// the content does not move.
				node.style.height = `${from + (target - from) * progress}px`;
				// Release as soon as the spring has CONVERGED, rather than
				// waiting for the hard cap: past this point the remaining
				// motion is under a pixel and only the clip is visible.
				//
				// The test is in PIXELS, not in progress: a fraction that
				// means "nothing" on a 20px row is three pixels on a 400px
				// one, and releasing three pixels short leaves the box
				// clipped at the wrong height.
				// The spring has SETTLED when it is both near the target and
				// no longer moving. Nearness alone is not enough: on the way
				// UP the spring passes within half a pixel of the target
				// before sailing past it, and releasing there would cut the
				// overshoot — the very thing the spring is for.
				const remainingPx = Math.abs(target - from) * Math.abs(progress - 1);
				const movingPx = Math.abs(target - from) * Math.abs(velocity);
				if (remainingPx < 0.5 && movingPx < 4) settle();
			},
			settle,
		);
		return () => {
			// Interrupted by a newer morph (or unmount): restore natural
			// layout NOW — the next run's render-phase capture reads the
			// mid-flight height as its from (the visual state), and its
			// own measurement then sees an unpinned target. Without this
			// a stale pin outlives the run and the content stays clipped.
			settle();
		};
	}, [morphKey, fade]);
	return (
		<div
			className={`${fade ? "gui-morph-fade" : ""}${className ? `${fade ? " " : ""}${className}` : ""}`}
			ref={el => {
				ref.current = el;
				if (typeof innerRef === "function") innerRef(el);
				else if (innerRef) innerRef.current = el;
			}}
		>
			{children}
		</div>
	);
}
