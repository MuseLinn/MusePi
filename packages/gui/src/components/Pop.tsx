import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Menu popup mount duration (must match gui-menu-in/-out keyframes). */
export const MENU_ANIM_MS = 130;

/**
 * Animated popup (openchamber dropdown parity): mounts with the fade+scale
 * gui-menu-in animation and, when `open` flips false, stays mounted for the
 * gui-menu-out exit before unmounting. Marked data-header-menu so header
 * outside-click/Escape handlers can ignore clicks inside it; any consumer
 * may use the attribute for the same purpose.
 *
 * `portal` mode renders through a portal into the React root with a
 * viewport-fixed position under the `anchor` element. The header popups use
 * it so their z-index lives in the GLOBAL stacking context (above the chat
 * surface) instead of being trapped inside the header's own stacking
 * context (the header must stay z-index:1 for its glass ::before).
 */
export function Pop({
	open,
	className,
	children,
	anchor,
	portal = false,
	align = "left",
}: {
	open: boolean;
	className: string;
	children: ReactNode;
	/** Portal mode: the element the menu drops below. */
	anchor?: HTMLElement | null;
	portal?: boolean;
	/** Which edge of the anchor the menu aligns to. */
	align?: "left" | "right";
}): ReactNode {
	const [visible, setVisible] = useState(open);
	const [closing, setClosing] = useState(false);
	// Two-phase enter (ContextMenu/useFloatingMenu parity): mount at
	// opacity 0 WITHOUT the animation class so the frosted backdrop
	// composites first, then start gui-menu-in next frame. Animating a
	// freshly-mounted backdrop-filter element makes Chromium skip its
	// backdrop sampling on the real compositor (menu renders as plain
	// translucency — content shows straight through, no frost).
	const [entered, setEntered] = useState(false);
	const [pos, setPos] = useState<{ left?: number; right?: number; top: number } | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (open) {
			setClosing(false);
			setVisible(true);
			setEntered(false);
			const id = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
			return () => cancelAnimationFrame(id);
		}
		if (!visible) return;
		setClosing(true);
		const id = setTimeout(() => setVisible(false), MENU_ANIM_MS);
		return () => clearTimeout(id);
	}, [open, visible]);

	// Portal mode: measure the anchor and pin the menu below it (fixed to
	// the viewport, so it escapes any ancestor stacking context).
	useEffect(() => {
		if (!portal || !open) return;
		const anchorEl = anchor;
		if (!anchorEl) return;
		const r = anchorEl.getBoundingClientRect();
		setPos({
			...(align === "right"
				? { right: Math.max(4, window.innerWidth - r.right) }
				: { left: Math.min(r.left, window.innerWidth - 260) }),
			top: r.bottom + 6,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, portal, anchor, align]);

	if (!visible) return null;
	const style: CSSProperties | undefined =
		portal && pos
			? { position: "fixed", left: pos.left, right: pos.right, top: pos.top, bottom: undefined }
			: undefined;
	const menu = (
		<div
			ref={menuRef}
			data-header-menu=""
			className={`${className}${!entered && !closing ? " gui-menu-popup--pending" : ""}${entered ? " gui-menu-popup--entered" : ""}${closing ? " gui-menu-popup--closing" : ""}`}
			style={style}
		>
			{children}
		</div>
	);
	if (portal && pos) {
		return createPortal(menu, document.getElementById("root") ?? document.body);
	}
	return menu;
}
