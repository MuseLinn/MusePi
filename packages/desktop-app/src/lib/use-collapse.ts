import { useEffect, useRef } from "react";

const DURATION = 240;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Reliable collapse/expand animation for .gui-collapse blocks.
 *
 * Chromium's `grid-template-rows: 0fr ↔ 1fr` transition only plays one
 * way: 0fr → 1fr animates, but 1fr → 0fr snaps instantly (the start
 * value resolves to max-content and transitions from a flex track are
 * skipped). That made expansion smooth and collapse a hard pop — and the
 * open ease-out curve jumps ~30% of the height in the first frame.
 *
 * Instead the inner element's height is animated with explicit px:
 * - expand:   lock to current height → 0px → scrollHeight → back to auto
 *   on transitionend (so later content changes re-flow freely)
 * - collapse: lock to scrollHeight → 0px (stays hidden)
 *
 * The transition is applied inline so no CSS transition runs on initial
 * mount (first paint shows the target state without animation).
 */
export function useCollapse(open: boolean): (el: HTMLDivElement | null) => void {
	const innerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const inner = innerRef.current;
		if (!inner) return;

		// Already at the target state — nothing to animate.
		const current = inner.style.height;
		if (open && (current === "" || current === "auto")) return;
		if (!open && current === "0px") return;

		inner.style.transition = "none";
		if (open) {
			// From the locked height (0 after a collapse, px mid-flight,
			// auto after a settled expand) to the measured content height.
			const from = current === "auto" || current === "" ? 0 : parseFloat(current);
			inner.style.height = `${Number.isFinite(from) ? from : 0}px`;
		} else {
			inner.style.height = `${inner.scrollHeight}px`;
		}
		// Force a reflow so the start value sticks before the transition
		// is enabled.
		void inner.offsetHeight;
		inner.style.transition = `height ${DURATION}ms ${EASING}`;
		inner.style.height = open ? `${inner.scrollHeight}px` : "0px";

		const settle = (): void => {
			// Returning to auto after an expand keeps the block responsive
			// to content changes; a collapsed block stays at 0px.
			if (open) inner.style.height = "auto";
		};
		const timer = setTimeout(settle, DURATION + 60);
		const onEnd = (): void => {
			clearTimeout(timer);
			settle();
		};
		inner.addEventListener("transitionend", onEnd, { once: true });
		return () => {
			clearTimeout(timer);
			inner.removeEventListener("transitionend", onEnd);
		};
	}, [open]);

	return (el: HTMLDivElement | null): void => {
		innerRef.current = el;
	};
}
