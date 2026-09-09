import type { RefObject } from "react";
import { useEffect } from "react";

/**
 * Content-boundary feather (openchamber ScrollShadow parity): observes a
 * scroll container and maintains `data-top-scroll` / `data-bottom-scroll`
 * attributes that CSS mask-image rules key off — the top/bottom content
 * fade engages only while the content actually overflows and is scrolled
 * away from the edge. Shared by the transcript (JumpToBottomButton), the
 * sidebar session list, the settings panes, and the model-selector menu.
 *
 * `onMeasure` runs on every scroll/resize/mutation (after the data attrs
 * are updated) so callers can drive their own state from the same pass.
 *
 * The container may mount AFTER the effect first runs (conditional
 * rendering: floating menus, overlays) — when `rootRef.current` is still
 * null the hook polls briefly (100ms) and subscribes as soon as the
 * element appears, instead of silently never observing it.
 */
export function useScrollShadow(rootRef: RefObject<HTMLElement | null>, onMeasure?: (el: HTMLElement) => void): void {
	useEffect(() => {
		let cleanup: (() => void) | undefined;
		let lastEl: HTMLElement | null = rootRef.current;

		const setup = (root: HTMLElement): void => {
			const measure = (): void => {
				const el = rootRef.current;
				if (!el) return;
				// Fade mask engages only while the content overflows.
				el.dataset.topScroll = el.scrollTop > 8 ? "true" : "false";
				el.dataset.bottomScroll = el.scrollTop + el.clientHeight < el.scrollHeight - 8 ? "true" : "false";
				onMeasure?.(el);
			};
			root.addEventListener("scroll", measure, { passive: true });
			const ro = new ResizeObserver(measure);
			ro.observe(root);
			// Content growth (streaming / list updates) changes scrollHeight
			// without a scroll event — re-measure on child mutations, RAF-throttled.
			let raf = 0;
			const mo = new MutationObserver(() => {
				cancelAnimationFrame(raf);
				raf = requestAnimationFrame(measure);
			});
			mo.observe(root, { childList: true, subtree: true });
			const onVis = (): void => {
				if (document.visibilityState === "visible") measure();
			};
			document.addEventListener("visibilitychange", onVis);
			measure();
			cleanup = () => {
				root.removeEventListener("scroll", measure);
				ro.disconnect();
				mo.disconnect();
				cancelAnimationFrame(raf);
				document.removeEventListener("visibilitychange", onVis);
			};
		};

		if (lastEl) setup(lastEl);
		// The container may mount later (conditional rendering: floating
		// menus, overlays) AND may be swapped out when it closes/reopens
		// (menu unmounts its list). Poll: re-subscribe whenever the element
		// changes, cheap while absent.
		const iv = window.setInterval(() => {
			const el = rootRef.current;
			if (el === lastEl) return;
			cleanup?.();
			lastEl = el;
			if (el) setup(el);
		}, 200);
		return () => {
			window.clearInterval(iv);
			cleanup?.();
		};
	}, [rootRef, onMeasure]);
}
