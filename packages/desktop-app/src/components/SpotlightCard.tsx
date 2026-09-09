import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useRef, useState } from "react";

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
}: {
	children: ReactNode;
	className?: string;
	/** Glow tint (theme-aware callers pass an accent-tinted rgba). */
	spotlightColor?: string;
	/** Glow radius, px. */
	glowSize?: number;
}): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
	const [opacity, setOpacity] = useState(0);

	const onMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
	};

	const style: CSSProperties = {
		background: `radial-gradient(${glowSize}px circle at ${Math.round(pos.x)}px ${Math.round(pos.y)}px, ${spotlightColor}, transparent 70%)`,
		opacity,
	};

	return (
		<div
			ref={ref}
			className={`gui-spotlight${className ? ` ${className}` : ""}`}
			onMouseMove={onMove}
			onMouseEnter={() => setOpacity(1)}
			onMouseLeave={() => setOpacity(0)}
		>
			<div className="gui-spotlight-glow" aria-hidden="true" style={style} />
			{children}
		</div>
	);
}
