import { useEffect, useState } from "react";

/**
 * Two-phase enter for frosted overlays (DialogFrame/Pop/useFloatingMenu
 * parity): returns the `--entered` suffix — empty while pending. The host
 * paints its first frame at opacity 0 WITHOUT an animation class so the
 * backdrop-filter element composites (and samples its backdrop) before any
 * enter animation plays. Animating a freshly-mounted backdrop-filter
 * element makes Chromium skip backdrop sampling on the real compositor,
 * so the frost never appears (docs/gui-implementation.md §6.5).
 *
 * `active` is typically `open` or `element !== null`. Every false→true
 * transition restarts the pending frame; the suffix resets on close so a
 * remount never carries a stale animation class. The host CSS must gate
 * visibility on the suffix's `opacity: 1` (base rule `opacity: 0`), which
 * also makes `gui-motion-off` degrade to an instant appear.
 *
 * ⚠ The caller MUST keep the base class AND append the full BEM modifier:
 * `className={`gui-foo${entered ? " gui-foo--entered" : ""}`}` (ContextMenu
 * /Pop parity). Concatenating without the base (`gui-foo${entered}` →
 * `gui-foo--entered`) drops the fixed positioning / backdrop-filter, and
 * space-joining the raw suffix (`gui-foo --entered`) leaves an orphan
 * `--entered` class that matches nothing — all five original callers hit
 * one of these and rendered in normal flow or stuck at opacity 0
 * (2026-08-11).
 */
export function useTwoPhaseEnter(active: boolean, suffix = "--entered"): string {
	const [entered, setEntered] = useState(false);
	useEffect(() => {
		setEntered(false);
		if (!active) return;
		// Two rAF hops: the first paints the pending frame (frost
		// composites), the second starts the enter animation.
		let raf2 = 0;
		const raf1 = requestAnimationFrame(() => {
			raf2 = requestAnimationFrame(() => setEntered(true));
		});
		return () => {
			cancelAnimationFrame(raf1);
			cancelAnimationFrame(raf2);
		};
	}, [active]);
	return entered ? suffix : "";
}
