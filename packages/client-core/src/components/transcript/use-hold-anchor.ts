import type { RefObject } from "react";
import { useLayoutEffect, useRef } from "react";
import { foldCloseNeedsPin, markFoldPinned } from "./scroll-anchor";

/**
 * Keep the reader still when a fold above them closes.
 *
 * A fold entirely above the viewport closes AT ONCE and pins the content below
 * it where it was. Animating it instead moves everything under the reader by
 * the fold's height — they were reading the reply, and the reply jumps up by
 * however much process was above it. The transcript scroller also disables the
 * browser's scroll anchoring (it virtualizes), so nothing else compensates.
 *
 * The pin happens in a layout effect, before paint: the collapsing slots'
 * transitions are muted for the closed frame, their collapsed height is forced,
 * the header's viewport offset is restored, and the transitions are re-armed on
 * the next frame. The reader never sees the intermediate position.
 *
 * The anchor is the fold header, which rides the reply once the fold is closed:
 * holding ITS viewport offset holds the reply, and everything under it. The
 * height the fold gives back lives in the closed turn's `.tr-fold-slot`s, which
 * are siblings of the reply row rather than of the header — so they are found
 * from the scroller, not from the header's subtree.
 *
 * Attach the returned ref to the fold header element.
 */
export function useHoldAnchor(open: boolean): RefObject<HTMLButtonElement | null> {
	const headerRef = useRef<HTMLButtonElement | null>(null);
	const prevOpen = useRef(open);
	useLayoutEffect(() => {
		const wasOpen = prevOpen.current;
		prevOpen.current = open;
		// Only a CLOSE can push content.
		if (wasOpen === false || open === true) return;
		const header = headerRef.current;
		if (!header) return;
		const scroller = header.closest<HTMLElement>("[data-transcript-scroller]");
		if (!scroller) return;
		// The slots giving height back. A `--open` slot belongs to a run the
		// reader just expanded: it is growing, and muting it would snap it.
		const slots = Array.from(scroller.querySelectorAll<HTMLElement>(".tr-fold-slot:not(.tr-fold-slot--open)"));
		if (slots.length === 0) return;
		const scrollerTop = scroller.getBoundingClientRect().top;
		// A fold the reader can still see collapsing is the animation they
		// expect; only a fold that ends above the visible top gets pinned.
		const foldBottom = Math.max(...slots.map(slot => slot.getBoundingClientRect().bottom));
		if (!foldCloseNeedsPin(foldBottom, scrollerTop)) return;

		const before = header.getBoundingClientRect().top;
		const muted = slots.map(slot => slot.style.transition);
		for (const slot of slots) slot.style.transition = "none";
		// Force style/layout so the collapsed height is the one measured below;
		// without this the delta is near zero and the rows slide during the
		// animation.
		void scroller.offsetHeight;
		const delta = header.getBoundingClientRect().top - before;
		if (delta !== 0) {
			markFoldPinned(scroller);
			scroller.scrollTop += delta;
		}
		const rearm = (): void => {
			slots.forEach((slot, i) => {
				slot.style.transition = muted[i] ?? "";
			});
		};
		const frame = window.requestAnimationFrame(rearm);
		return () => {
			window.cancelAnimationFrame(frame);
			rearm();
		};
	}, [open]);
	return headerRef;
}
