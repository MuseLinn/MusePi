import type { ReactNode } from "react";
import { useFloatingMenu } from "../lib/use-floating-menu";

/** Menu popup mount duration (must match gui-menu-in/-out keyframes). */
export const MENU_ANIM_MS = 130;

/**
 * Animated popup (openchamber dropdown parity): mounts with the fade+scale
 * gui-menu-in animation and, when `open` flips false, stays mounted for the
 * gui-menu-out exit before unmounting. Marked data-header-menu so header
 * outside-click/Escape handlers can ignore clicks inside it; any consumer
 * may use the attribute for the same purpose.
 *
 * Portal-rendered through {@link useFloatingMenu} into the React root with a
 * viewport-fixed position under the `anchor` element — the SINGLE floating
 * menu implementation app-wide (mutex: opening any menu closes the previous
 * one; opens upward when there is more room above; uniform gui-menu-in/out
 * animation). The header popups use it so their z-index lives in the GLOBAL
 * stacking context (above the chat surface) instead of being trapped inside
 * the header's own stacking context (the header must stay z-index:1 for its
 * glass ::before).
 *
 * `onOpenChange` is REQUIRED for the mutex to work: when another menu opens,
 * the mutex calls it with false so this popup's owner state closes. Callers
 * that manage their own outside-click/Escape (GuiHeader closeAll, the
 * SettingsView card menus) pass their setter; the mutex then closes them
 * automatically instead of leaving two menus on screen.
 */
export function Pop({
	open,
	className,
	children,
	anchor,
	onOpenChange,
	portal = true,
	align = "left",
}: {
	open: boolean;
	className: string;
	children: ReactNode;
	/** The element the menu drops below. */
	anchor?: HTMLElement | null;
	/** Owner-state setter — lets the global menu mutex close this popup. */
	onOpenChange?: (open: boolean) => void;
	/** Accepted for backward compatibility — all menus portal now. */
	portal?: boolean;
	/** Which edge of the anchor the menu aligns to. */
	align?: "left" | "right";
}): ReactNode {
	return useFloatingMenu(open, onOpenChange, { className, align, anchor }).renderMenu(children);
}
