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
 * The pin happens in a layout effect, before paint: the slot's transition is
 * muted for the closed frame, the collapsed height is forced, the header's
 * viewport offset is restored, and the transition is re-armed on the next
 * frame. The reader never sees the intermediate position.
 *
 * The anchor is the fold header itself, which stays put: holding ITS viewport
 * offset holds everything under it. The slot is the fold's height-carrying
 * sibling, found from the header, so a caller attaches one ref and nothing else.
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
		const slot = header.parentElement?.querySelector<HTMLElement>(":scope > .tr-fold-slot") ?? null;
		const scroller = header.closest<HTMLElement>("[data-transcript-scroller]");
		if (!slot || !scroller) return;
		if (!foldCloseNeedsPin(slot.getBoundingClientRect().top, scroller.getBoundingClientRect().top)) return;

		const before = header.getBoundingClientRect().top;
		// Mute the height transition for this frame so the closed height is the
		// one measured below; without this the delta is near zero and the rows
		// slide during the animation.
		const previousTransition = slot.style.transition;
		slot.style.transition = "none";
		// Force style/layout so the collapsed height is what we measure.
		void slot.offsetHeight;
		const delta = header.getBoundingClientRect().top - before;
		if (delta !== 0) {
			markFoldPinned(scroller);
			scroller.scrollTop += delta;
		}
		const frame = window.requestAnimationFrame(() => {
			slot.style.transition = previousTransition;
		});
		return () => {
			window.cancelAnimationFrame(frame);
			slot.style.transition = previousTransition;
		};
	}, [open]);
	return headerRef;
}
