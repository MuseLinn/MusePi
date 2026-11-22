/**
 * ConnectionLocationRow — the one row anatomy for both connection axes.
 *
 * The two axes are separate concepts (an instance chooses where the daemon
 * runs, a workspace chooses where the files live) but they present the *same
 * fact shape*: a leading mark, a name, where it runs, and a status. Rendering
 * that shape twice is how the two lists drifted apart — the daemon list put a
 * 7px dot first and a chip on the current row only, the workspace list put a
 * 24px glyph first and a status on every row, so the name began 50px in one
 * list and 579px in the other and half the rows had no trailing slot at all.
 *
 * The differences between the lists are therefore parameters, not layout:
 *
 *  - `leading` — `"dot"` (a 7px presence mark, for an endpoint that may be up
 *    or down) or `"glyph"` (a 24px icon box, for a host kind);
 *  - `status` — **always present**, so the trailing slot sits at one x across
 *    both surfaces. A row with nothing to report still renders it (the caller
 *    passes the state word; an empty string keeps the slot and its width);
 *  - `action` — the optional trailing control (remove, a check mark), rendered
 *    as a sibling of the row button so the row box stays the whole hit area
 *    (M86's honest-hit-area rule) and a destructive control is never nested
 *    inside the target it would destroy.
 *
 * The row box is the button: clicking anywhere in it is the row's own action.
 */

import type { ReactNode } from "react";
import type { IconName } from "../vendor/oc-icons";
import { Icon } from "../vendor/oc-icons";

export interface ConnectionLocationRowProps {
	/** Leading mark: a presence dot or a kind glyph. */
	leading: "dot" | "glyph";
	/** Glyph name when `leading` is `"glyph"`; ignored for `"dot"`. */
	glyph?: IconName;
	/** The row's name — a machine or an endpoint label. */
	name: string;
	/** Where it runs. A machine, never a tunnel's own loopback address. */
	where: string;
	/** Full value for the `where` cell's tooltip, when it can be truncated. */
	whereTitle?: string;
	/** The status word for the always-present trailing slot. */
	status: string;
	/**
	 * Machine-readable status for styling (`connected`, `disconnected`, `idle`).
	 * Separate from the word so colour never carries the meaning alone.
	 */
	statusKind?: "connected" | "disconnected" | "idle";
	/** Marks the row the shell is currently on. */
	current?: boolean;
	/** Disables the row's own action (the current row is not a target). */
	disabled?: boolean;
	/** Accessible pressed state, for a list that selects rather than navigates. */
	pressed?: boolean;
	onActivate(): void;
	/** Optional trailing control, rendered beside — never inside — the row box. */
	action?: ReactNode;
}

export function ConnectionLocationRow({
	leading,
	glyph,
	name,
	where,
	whereTitle,
	status,
	statusKind = "idle",
	current = false,
	disabled = false,
	pressed,
	onActivate,
	action,
}: ConnectionLocationRowProps): ReactNode {
	return (
		<li className="gui-loc-row" data-current={current ? "true" : undefined} data-status={statusKind}>
			<button
				type="button"
				className="gui-loc-row-main"
				onClick={onActivate}
				disabled={disabled}
				aria-current={current ? "true" : undefined}
				aria-pressed={pressed}
			>
				{/* The leading slot is a fixed-width box whichever mark it holds, so the
				 * name starts at the same offset in both lists — a bare 7px dot beside a
				 * 24px glyph otherwise shifted it by 17px. */}
				<span className="gui-loc-lead" aria-hidden>
					{leading === "glyph" ? (
						<span className="gui-loc-glyph">
							<Icon name={glyph ?? "server"} className="h-3.5 w-3.5" />
						</span>
					) : (
						<span className="gui-loc-dot" />
					)}
				</span>
				<span className="gui-loc-name">{name}</span>
				<span className="gui-loc-where" title={whereTitle ?? where}>
					{where}
				</span>
				{/* Always rendered: this is what puts the trailing slot at one x in
				 * both lists, whether or not the row has a status word to show. */}
				<span className="gui-loc-status">{status}</span>
			</button>
			{/* The action slot is always present and always the same width, so a row
			 * without a control does not widen its button and drag the status right.
			 * A destructive control stays outside the button it would destroy. */}
			<span className="gui-loc-action">{action}</span>
		</li>
	);
}
