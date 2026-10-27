import type { CSSProperties, HTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useRef } from "react";

/**
 * Mouse-follow spotlight card (reactbits SpotlightCard parity,
 * zero-dependency): a radial-gradient glow tracks the pointer over the
 * card and fades in/out on enter/leave. Pure behavior — the caller's
 * className carries the card chrome (border/radius/background) so it
 * composes with existing `.gui-*` card styles.
 */
export function SpotlightCard({
	children,
	className,
	spotlightColor = "rgba(255, 255, 255, 0.12)",
	glowSize = 240,
	...props
}: HTMLAttributes<HTMLDivElement> & {
	children: ReactNode;
	/** Glow tint (theme-aware callers pass an accent-tinted rgba). */
	spotlightColor?: string;
	/** Glow radius, px. */
	glowSize?: number;
}): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	const glowRef = useRef<HTMLDivElement | null>(null);
	const background = (x: number, y: number): string =>
		`radial-gradient(${glowSize}px circle at ${Math.round(x)}px ${Math.round(y)}px, ${spotlightColor}, transparent 70%)`;

	const onMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
		const el = ref.current;
		const glow = glowRef.current;
		if (!el || !glow) return;
		const rect = el.getBoundingClientRect();
		glow.style.background = background(e.clientX - rect.left, e.clientY - rect.top);
	};

	// Touch: pointer events cover mouse + touch. No pointermove on tap-only
	// screens, so keep a faint center glow by default (opacity starts low).
	const style: CSSProperties = { background: background(0, 0), opacity: 0.25 };

	return (
		<div
			{...props}
			ref={ref}
			className={`gui-spotlight${className ? ` ${className}` : ""}`}
			onPointerMove={onMove}
			onPointerEnter={() => {
				if (glowRef.current) glowRef.current.style.opacity = "1";
			}}
			onPointerLeave={() => {
				if (glowRef.current) glowRef.current.style.opacity = "0.25";
			}}
		>
			<div ref={glowRef} className="gui-spotlight-glow" aria-hidden="true" style={style} />
			{children}
		</div>
	);
}
