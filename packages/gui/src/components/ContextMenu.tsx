import type { ReactNode } from "react";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { tapFeedback } from "../lib/haptic";
import { Icon } from "../vendor/oc-icons";

export interface ContextMenuItem {
	label?: string;
	icon?: string;
	/** Omitted only on divider items. */
	onSelect?(): void;
	/** Shortcut hint shown right-aligned (⌘N style). */
	hint?: string;
	/** Renders a divider before this item. */
	divider?: boolean;
	danger?: boolean;
	/** Disabled item (grayed, not clickable). */
	disabled?: boolean;
	/** Accent color name for the leading dot (group color picker). */
	color?: string;
}

/**
 * Right-click menu (ZCode task context menu). Thin adapter over
 * {@link useFloatingMenu} — the single floating-menu implementation:
 * portal into the React root, viewport-fixed positioning at the pointer
 * (point anchor, opens upward when there is more room above), two-phase
 * transform-only enter, outside-click / Escape close, and the global
 * menu mutex (opening any other menu closes this one).
 */
export function ContextMenu({
	x,
	y,
	items,
	onClose,
	open,
}: {
	x: number;
	y: number;
	items: ContextMenuItem[];
	onClose(): void;
	open: boolean;
}): ReactNode {
	const { renderMenu } = useFloatingMenu(open, onClose, {
		className: "gui-context-menu",
		anchor: open ? { x, y } : null,
	});
	return renderMenu(
		<div role="menu">
			{items.map((item, i) => (
				// Menu rows are static call-site arrays — the index is the identity.
				<div key={i}>
					{item.divider && <div className="gui-context-divider" />}
					<button
						type="button"
						disabled={item.disabled}
						className={`gui-context-item${item.danger ? " gui-context-item--danger" : ""}${item.disabled ? " gui-context-item--disabled" : ""}`}
						role="menuitem"
						onClick={() => {
							tapFeedback();
							onClose();
							item.onSelect?.();
						}}
					>
						{item.color ? (
							<span className={`gui-dot gui-dot-${item.color}`} />
						) : item.icon ? (
							<Icon name={item.icon as never} className="h-3.5 w-3.5" />
						) : null}
						<span className="min-w-0 flex-1 truncate">{item.label}</span>
						{item.hint && <span className="gui-context-hint">{item.hint}</span>}
					</button>
				</div>
			))}
		</div>,
	);
}
