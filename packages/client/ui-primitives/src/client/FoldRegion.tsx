import { type ReactNode, useEffect, useRef, useState } from "react";
import "./FoldRegion.css";

/** Matches the CSS transition on `.fold-region`; children unmount just after
 *  the track finishes closing (Kimi Code客户端 uses the same 200ms contract). */
const UNMOUNT_AFTER_MS = 200;

/**
 * One collapse primitive for every foldable surface (turn fold, tool run,
 * thinking block, long user message).
 *
 * The track itself animates: `grid-template-rows: minmax(0, 0fr)` ↔
 * `minmax(0, 1fr)`, with the child as a `min-height: 0` grid item. Two reasons
 * this is the contract rather than `height: 0 ↔ auto` or a JS-measured `--h`:
 *
 * - The two ends are exact. `auto` has no animatable start value without
 *   `interpolate-size`, and a JS height needs a reflow before every toggle;
 *   a grid track animates between the two used sizes the layout already knows.
 * - Opening mounts the content one frame BEFORE the track is told to open
 *   (double rAF), so the transition never starts from a stale empty box; closing
 *   keeps the content mounted until the track lands at zero and then unmounts,
 *   so the collapse is visible instead of a pop.
 *
 * Closed regions are `inert` (not tabbable, not announced); the header that
 * owns the toggle keeps `aria-expanded` and points `aria-controls` at `id`.
 * `prefers-reduced-motion` removes the transition in CSS, which also makes the
 * unmount timer the only visible effect.
 */
export function FoldRegion({
	open,
	id,
	children,
	className,
	keepMounted = false,
}: {
	open: boolean;
	/** Target of the header's `aria-controls`. */
	id?: string;
	children: ReactNode;
	className?: string;
	/** Keep the subtree mounted while closed (surfaces whose children hold
	 *  state that must survive a collapse). Default unmounts after the close. */
	keepMounted?: boolean;
}): ReactNode {
	const [mounted, setMounted] = useState(open);
	const [expanded, setExpanded] = useState(open);
	const wasOpen = useRef(open);

	useEffect(() => {
		const was = wasOpen.current;
		wasOpen.current = open;
		if (was === open) return;
		if (open) {
			setMounted(true);
			let inner = 0;
			const outer = requestAnimationFrame(() => {
				inner = requestAnimationFrame(() => setExpanded(true));
			});
			return () => {
				cancelAnimationFrame(outer);
				if (inner) cancelAnimationFrame(inner);
			};
		}
		setExpanded(false);
		if (keepMounted) return;
		const timer = setTimeout(() => setMounted(false), UNMOUNT_AFTER_MS);
		return () => clearTimeout(timer);
	}, [open, keepMounted]);

	return (
		<div
			id={id}
			className={`fold-region${expanded ? " fold-region--open" : ""}${className === undefined ? "" : ` ${className}`}`}
			inert={!open}
			aria-hidden={!open}
		>
			<div className="fold-region-inner">{mounted ? children : null}</div>
		</div>
	);
}
