import type { ReactNode } from "react";

/**
 * The pill inside a pane splitter's hit band.
 *
 * Every resizable seam in the GUI — sidebar|chat, chat|right panel,
 * chat|terminal dock — is a hit band that owns the seam coordinate plus one
 * of these pills, which is the only visible affordance and takes no pointer
 * events (`pointer-events: none`), so the band underneath receives every
 * grab. The structure and the whole look are the standard in
 * `docs/gui-design.md` §4 ("Splitter grip"); geometry lives in `tokens.css`
 * as `--gui-grip-*` and the primitive in `styles/gui-settings.css`.
 *
 * The pill states are driven by ATTRIBUTES THE BAND PROPAGATES, not by an
 * ancestor descendant chain: the CSS minifier flattens `:is(…)>` into an
 * unparented `.gui-split-grip` rule that paints every grip at rest, and
 * `body.gui-resizing` is global (it also lights the seams you are not
 * dragging). `usePointerDrag` therefore writes `data-resizing` onto the band
 * and this pill; hover/focus reach it through `:has()` on the band.
 *
 * This exists so a new splitter mounts `<SplitterGrip />` instead of
 * copying the span — the fifth copy would otherwise be the fifth hand-rolled
 * affordance.
 */
export function SplitterGrip({ orientation = "vertical" }: { orientation?: "vertical" | "horizontal" }): ReactNode {
	// `--row` swaps the two axes: a horizontal seam carries the pill's length
	// along the seam (which is horizontal), not across it.
	const cls = orientation === "horizontal" ? "gui-split-grip gui-split-grip--row" : "gui-split-grip";
	return <span className={cls} aria-hidden="true" />;
}
