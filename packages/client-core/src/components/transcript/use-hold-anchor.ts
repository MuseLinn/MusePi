import type { RefObject } from "react";
import { useEffect, useRef } from "react";

/**
 * Keep the reader still when a fold above them closes.
 *
 * A fold entirely above the viewport must close AT ONCE and pin the content
 * below it where it was. Letting it animate instead moves everything under the
 * reader by the fold's height — they were reading the reply, and the reply
 * jumps up by however much process was above it. The transcript scroller also
 * disables the browser's scroll anchoring (it virtualizes), so nothing else
 * compensates.
 *
 * The anchor is the fold header itself, which stays put: holding ITS viewport
 * offset holds everything under it. The slot is the fold's height-carrying
 * sibling, found from the header, so a caller attaches one ref and nothing else.
 *
 * Attach the returned ref to the fold header element.
 */

/** How long the fold's height transition runs (must match .tr-fold-slot). */
const FOLD_TRANSITION_MS = 220;

export function useHoldAnchor(open: boolean): RefObject<HTMLButtonElement | null> {
	const headerRef = useRef<HTMLButtonElement | null>(null);
	const prevOpen = useRef(open);
	useEffect(() => {
		const wasOpen = prevOpen.current;
		prevOpen.current = open;
		// Only a CLOSE can push content, and only when the fold is entirely
		// above the reader (a fold in view animates, which is what they expect).
		if (wasOpen === false || open === true) return;
		const header = headerRef.current;
		if (!header) return;
		const slot = header.parentElement?.querySelector<HTMLElement>(".tr-fold-slot") ?? null;
		if (!slot) return;
		if (slot.getBoundingClientRect().top >= 0) return;

		const before = header.getBoundingClientRect().top;
		const scroller = header.closest<HTMLElement>("[data-transcript-scroller]");
		if (!scroller) return;
		const restore = (): void => {
			const delta = header.getBoundingClientRect().top - before;
			if (delta !== 0) scroller.scrollTop += delta;
		};
		// Wait for the transition to finish before correcting: measuring
		// mid-animation would compare against a moving height and leave the
		// anchor slightly off.
		const id = window.setTimeout(restore, FOLD_TRANSITION_MS + 20);
		return () => window.clearTimeout(id);
	}, [open]);
	return headerRef;
}
