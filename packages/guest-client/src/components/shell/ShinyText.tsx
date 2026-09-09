import type { CSSProperties, ReactNode } from "react";

/**
 * Shiny text sweep (reactbits ShinyText parity, zero-dependency): the text
 * is filled with a gradient (base color + shine highlight) and a highlight
 * band sweeps across periodically via pure CSS background-position
 * keyframes — no JS timer, respects `gui-motion-off` (falls back to plain
 * text fill). All knobs are CSS variables so callers tune per instance.
 */
export function ShinyText({
	text,
	className,
	speed = 2.8,
	spread = 110,
	shineColor,
	baseColor,
}: {
	text: string;
	className?: string;
	/** One full sweep, seconds. */
	speed?: number;
	/** Gradient angle, deg. */
	spread?: number;
	/** Highlight color (defaults to white at 80%). */
	shineColor?: string;
	/** Base text color (defaults to currentColor). */
	baseColor?: string;
}): ReactNode {
	const style: CSSProperties = {
		"--shiny-speed": `${speed}s`,
		"--shiny-spread": `${spread}deg`,
		...(shineColor ? { "--shiny-shine": shineColor } : {}),
		...(baseColor ? { "--shiny-color": baseColor } : {}),
	} as CSSProperties;
	return (
		<span className={`gui-shiny-text${className ? ` ${className}` : ""}`} style={style}>
			{text}
		</span>
	);
}
