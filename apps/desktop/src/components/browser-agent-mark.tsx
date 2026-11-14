import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { mapPagePoint } from "../lib/browser-viewport";

/**
 * Where the agent just acted, drawn over the managed page.
 *
 * The guest webview paints above the pane's DOM, so the mark is portalled to
 * the document body and positioned in viewport coordinates — the same reason
 * the takeover card portals. The point is the CSS pixel the agent dispatched;
 * `mapPagePoint` applies the preset's centering and fit scale.
 */
export function BrowserAgentMark({
	mark,
	origin,
	page,
}: {
	mark: { x: number; y: number; kind: "click" | "scroll"; at: number } | null;
	origin: { x: number; y: number } | null;
	page: { left: number; scale: number } | null;
}): ReactNode {
	if (!mark || !origin) return null;
	const point = mapPagePoint(mark, origin, page);
	const node = (
		<span
			key={mark.at}
			className="gui-browser-agent-mark"
			data-kind={mark.kind}
			style={{ left: point.x, top: point.y }}
		/>
	);
	return typeof document === "undefined" ? node : createPortal(node, document.body);
}
