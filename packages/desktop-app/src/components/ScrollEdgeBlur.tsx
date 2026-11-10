import type { ReactNode } from "react";

/**
 * Progressive-blur scroll edge (one band).
 *
 * The bands must live OUTSIDE the scroller: Chromium does not sample scrolled
 * content for a `backdrop-filter` inside the scroll container, so an in-scroller
 * band paints only its tint. Put them in a `.gui-scroll-frame` next to the
 * scroller; the frame's `:has()` rules read the scroller's own
 * `data-top-scroll` / `data-bottom-scroll` (useScrollShadow) and show the band
 * only while content is actually hidden on that side.
 *
 * Frames that drive their own edge state (the capability center) keep their own
 * `[data-edge-*]` display rules — the band itself is the same recipe.
 */
export function ScrollEdgeBlur({ edge }: { edge: "top" | "end" }): ReactNode {
	return (
		<div className={`gui-edge-blur gui-edge-blur--${edge}`} aria-hidden="true">
			<span className="gui-edge-blur-tint" />
			<span className="gui-edge-blur-layer gui-edge-blur-layer--1" />
			<span className="gui-edge-blur-layer gui-edge-blur-layer--2" />
			<span className="gui-edge-blur-layer gui-edge-blur-layer--3" />
		</div>
	);
}
