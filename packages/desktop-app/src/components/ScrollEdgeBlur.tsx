import type { ReactNode } from "react";

/**
 * Progressive-blur scroll edge (one band).
 *
 * Render it as a SIBLING of the scroller inside a `.gui-scroll-frame`: the
 * frame's `:has()` rules read the scroller's own `data-top-scroll` /
 * `data-bottom-scroll` (useScrollShadow) and reveal the band. A band inside
 * the scroller would align to its padding edge and stop at the content box,
 * which leaves a sharp strip and a vertical seam on padded panes — the ramp
 * mask belongs on the band, never on a `backdrop-filter` layer.
 *
 * `overlay` is for a page that owns its edge flags and positions the band
 * itself (capability center, whose top band starts below the tool row).
 */
export function ScrollEdgeBlur({ edge, overlay }: { edge: "top" | "end"; overlay?: boolean }): ReactNode {
	return (
		<div
			className={`gui-edge-blur gui-edge-blur--${edge}${overlay ? " gui-edge-blur--overlay" : ""}`}
			aria-hidden="true"
		>
			<span className="gui-edge-blur-tint" />
			<span className="gui-edge-blur-layer gui-edge-blur-layer--1" />
			<span className="gui-edge-blur-layer gui-edge-blur-layer--2" />
			<span className="gui-edge-blur-layer gui-edge-blur-layer--3" />
		</div>
	);
}
