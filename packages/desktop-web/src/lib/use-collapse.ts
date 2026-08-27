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
export function useCollapseHeight(open: boolean, ref: RefObject<HTMLDivElement | null>, durationMs = 220): void {
	const animVer = useRef(0);
	const first = useRef(true);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ver = ++animVer.current;
		const setH = (v: string): void => el.style.setProperty("--h", v);
		if (first.current) {
			// Initial mount: land at the open/closed state directly.
			first.current = false;
			setH(open ? "auto" : "0px");
			return;
		}
		if (open) {
			setH("0px");
			void el.offsetHeight;
			setH(`${el.scrollHeight}px`);
			const done = (): void => {
				if (animVer.current === ver) setH("auto");
			};
			el.addEventListener("transitionend", done, { once: true });
			setTimeout(done, durationMs + 30);
		} else {
			// Collapse: pin the current rendered height, then shrink to 0.
			setH(`${el.scrollHeight}px`);
			void el.offsetHeight;
			setH("0px");
		}
	}, [open, ref, durationMs]);
}

/** Initial inline --h so first paint already matches the open state. */
export function collapseStyle(open: boolean): CSSProperties {
	return { "--h": open ? "auto" : "0px" } as CSSProperties;
}
