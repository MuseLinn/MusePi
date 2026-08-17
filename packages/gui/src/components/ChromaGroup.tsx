import type { HTMLAttributes, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useRef } from "react";

/**
 * Group-level chroma glow (reactbits ChromaGrid parity): ONE chromatic
 * light over the whole group, driven by the shared pointer — every card
 * inside lights up together, unlike per-card SpotlightCard glows. The
 * pointer writes --cg-x/--cg-y straight to the container (no re-render);
 * the .gui-chroma-glow layer is pure CSS and follows via those vars.
 * Composes: className carries the caller's grid layout styles, extra DOM
 * props (role/aria) pass through.
 */
export function ChromaGroup({
	children,
	className,
	...rest
}: {
	children: ReactNode;
	className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "className">): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
		const el = ref.current ?? e.currentTarget;
		const rect = el.getBoundingClientRect();
		el.style.setProperty("--cg-x", `${Math.round(e.clientX - rect.left)}px`);
		el.style.setProperty("--cg-y", `${Math.round(e.clientY - rect.top)}px`);
	};
	return (
		<div ref={ref} className={`gui-chroma${className ? ` ${className}` : ""}`} onPointerMove={onPointerMove} {...rest}>
			<div className="gui-chroma-glow" aria-hidden="true" />
			{children}
		</div>
	);
}
