import type { ReactNode } from "react";
import { tapFeedback } from "../lib/haptic";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";

export interface ContextMenuItem {
	label?: string;
	/** Secondary line under the label — explains what the action does
	 *  (right-click menus carry terse verbs; the description disambiguates). */
	description?: string;
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
		<div
			role="menu"
			aria-orientation="vertical"
			onKeyDown={e => {
				// Keyboard menu navigation: ↑/↓ cycle enabled items, Home/End
				// jump, Enter/Space activate. Esc handled by the floating menu.
				const buttons = Array.from(
					e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"),
				);
				if (buttons.length === 0) return;
				const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
				if (e.key === "ArrowDown") {
					e.preventDefault();
					buttons[(idx + 1) % buttons.length]!.focus();
				} else if (e.key === "ArrowUp") {
					e.preventDefault();
					buttons[(idx - 1 + buttons.length) % buttons.length]!.focus();
				} else if (e.key === "Home") {
					e.preventDefault();
					buttons[0]!.focus();
				} else if (e.key === "End") {
					e.preventDefault();
					buttons[buttons.length - 1]!.focus();
				} else if (e.key === "Enter" || e.key === " ") {
					const active = document.activeElement as HTMLButtonElement | null;
					if (active?.getAttribute("role") === "menuitem") {
						e.preventDefault();
						active.click();
					}
				}
			}}
		>
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
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate">{item.label}</span>
							{item.description && <span className="gui-context-desc">{item.description}</span>}
						</span>
						{item.hint && <span className="gui-context-hint">{item.hint}</span>}
					</button>
				</div>
			))}
		</div>,
	);
}
