import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";

const MORPH_MS = 240;
const MORPH_MS_MAX = 480;
const MORPH_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const FADE_ANIM = "gui-morph-fade-in 160ms ease";

/** Morph duration scales with the height delta: small settings rows stay
 * at the 240ms standard; large expansions (provider grids, tab bodies)
 * get up to 480ms so the unfold is actually perceptible — the ease-out
 * curve front-loads so hard that a fixed 240ms reads as a fast pop. */
function morphDurationMs(delta: number): number {
	return Math.min(MORPH_MS_MAX, Math.max(MORPH_MS, Math.round(delta / 6)));
}

/**
 * 高度形变动效规范 (height-morph standard) — for content that STAYS mounted
 * but changes height when `morphKey` changes: tab bodies with different
 * heights, in-place list growth (the providers "show all" toggle), etc.
 *
 * Mechanism: the pre-commit height is captured during render (ref read —
 * the DOM still shows the OLD content), the new content commits, then the
 * container eases old → new (240ms cubic-bezier(0.22, 1, 0.36, 1)) and
 * settles back to auto so later changes re-flow freely. The same element
 * carries the 160ms fade-in, restarted per morphKey.
 *
 * CRITICAL: children are rendered DIRECTLY into the container (no wrapper
 * div) — callers pass their own layout class (e.g. a CSS grid like
 * .gui-provider-grid) and a wrapper would collapse it to one grid item.
 *
 * For blocks that hide/show entirely use Reveal instead.
 */
export function HeightMorph({
	morphKey,
	className,
	children,
	innerRef,
}: {
	/** Value whose change triggers the morph (tab id, toggle state, …). */
	morphKey: unknown;
	className?: string;
	children: ReactNode;
	/** Extra ref for the morph container (e.g. a scroll-shadow observer on
	 *  a fixed-height scroll container that HeightMorph itself owns). */
	innerRef?: React.Ref<HTMLDivElement>;
}): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	const prevKey = useRef(morphKey);
	const prevHeight = useRef(0);
	const el = ref.current;
	if (el) prevHeight.current = el.getBoundingClientRect().height;
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node || prevKey.current === morphKey) return;
		prevKey.current = morphKey;
		// Restart the fade (the CSS animation ran once on mount).
		node.style.animation = "none";
		void node.offsetHeight;
		node.style.animation = FADE_ANIM;
		const target = node.offsetHeight;
		const delta = Math.abs(target - prevHeight.current);
		// Height unchanged (fixed-height scroll containers like the
		// settings content whose sections scroll INSIDE): nothing to
		// morph — pinning/clipping would hide the scrollbar and disable
		// scrolling for the whole transition window. Keep only the fade.
		if (delta < 1) return;
		const duration = morphDurationMs(delta);
		node.style.transition = "none";
		node.style.height = `${prevHeight.current}px`;
		// CRITICAL: clip the new content during the morph — without
		// overflow:hidden the content renders at its natural height the
		// instant the commit lands (it overflows the pinned box and pops
		// in), so only the invisible box edge moves and the unfold reads
		// as "no animation". Clipping makes it unfold with the box.
		node.style.overflow = "hidden";
		void node.offsetHeight;
		node.style.transition = `height ${duration}ms ${MORPH_EASING}`;
		node.style.height = `${target}px`;
		const settle = (): void => {
			node.style.height = "";
			node.style.transition = "";
			node.style.overflow = "";
		};
		node.addEventListener("transitionend", settle, { once: true });
		const timer = setTimeout(settle, duration + 60);
		return () => {
			clearTimeout(timer);
			node.removeEventListener("transitionend", settle);
		};
	}, [morphKey]);
	return (
		<div
			className={`gui-morph-fade${className ? ` ${className}` : ""}`}
			ref={el => {
				ref.current = el;
				if (typeof innerRef === "function") innerRef(el);
				else if (innerRef) innerRef.current = el;
			}}
		>
			{children}
		</div>
	);
}
