import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { tapFeedback } from "../lib/haptic";
import { Icon } from "../vendor/oc-icons";
import { MENU_ANIM_MS } from "./Pop";

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
 * Lightweight right-click menu (ZCode task context menu): absolutely
 * positioned at the pointer, closes on outside click / Escape, scrolls
 * within the sidebar when tall. Enter/exit both animate (gui-menu-in/-out);
 * the parent keeps it mounted via `open` so the fade-out can play.
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
	const [closing, setClosing] = useState(false);
	const [mounted, setMounted] = useState(open);
	// Two-phase enter (useFloatingMenu parity): mount WITHOUT the animation
	// class so the frosted backdrop composites first, then start gui-menu-in
	// next frame. Animating a freshly-mounted backdrop-filter element makes
	// Chromium skip/never re-run its backdrop sampling on the real
	// compositor — the menu then renders as plain translucency (visible
	// content showing straight through) instead of frosted glass.
	const [entered, setEntered] = useState(false);
	useEffect(() => {
		if (!mounted || !open) return;
		const id = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
		return () => cancelAnimationFrame(id);
	}, [mounted, open]);
	useEffect(() => {
		if (open) {
			setClosing(false);
			setMounted(true);
			return;
		}
		if (!mounted) return;
		setClosing(true);
		const id = setTimeout(() => setMounted(false), MENU_ANIM_MS);
		return () => clearTimeout(id);
	}, [open, mounted]);
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent): void => {
			const path = e.composedPath();
			if (path.some(el => el instanceof HTMLElement && el.classList?.contains("gui-context-menu"))) return;
			onClose();
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, onClose]);
	if (!mounted) return null;

	// Keep the menu inside the window.
	const style: Record<string, string> = {
		left: `${Math.min(x, window.innerWidth - 220)}px`,
		top: `${Math.min(y, window.innerHeight - Math.min(items.length * 30 + 12, 360))}px`,
	};

	return createPortal(
		<div
			className={`gui-context-menu${entered ? " gui-context-menu--entered" : ""}${closing ? " gui-menu-popup--closing" : ""}`}
			style={style}
			role="menu"
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
						<span className="min-w-0 flex-1 truncate">{item.label}</span>
						{item.hint && <span className="gui-context-hint">{item.hint}</span>}
					</button>
				</div>
			))}
		</div>,
		/* Portal to BODY (was #root): the React root lives inside the
		 * workspace glass layer (.gui-main carries backdrop-filter), and a
		 * backdrop-filter ancestor creates a containing block that kills
		 * the menu's own backdrop blur — the menu rendered as plain
		 * translucency with no frost (user report). Document-level close
		 * listeners are unaffected; the menu's own React events work. */
		document.body,
	);
}
