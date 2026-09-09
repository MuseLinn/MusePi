import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * Zero-dependency responsive progress ring (donut) — the pomodoro timer's
 * MM:SS ring, generalized. A circle keeps its aspect by construction, so the
 * anti-stretch concern is subtler than the line/bar charts: instead of a
 * `viewBox="0 0 120 120"` stretched by CSS, this measures its container and
 * renders the ring at `min(width, height)` so it stays a perfect circle at any
 * card size. Colors are CSS values (`var(--…)` ok) so the fill tracks the
 * accent token and the dark/light toggle.
 */

export interface DonutProps {
	/** Progress 0..1 (1 = full ring). */
	value: number;
	/** Fixed diameter in px; omit to fit the container (min of width/height). */
	size?: number;
	/** Ring stroke width. Default 8. */
	strokeWidth?: number;
	/** Progress color. Default `var(--color-accent)`. */
	color?: string;
	/** Track color. Default `var(--color-border)`. */
	trackColor?: string;
	/** Optional content centered inside the ring. */
	children?: ReactNode;
	className?: string;
}

export function Donut({
	value,
	size,
	strokeWidth = 8,
	color = "var(--color-accent)",
	trackColor = "var(--color-border)",
	children,
	className,
}: DonutProps): ReactNode {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [box, setBox] = useState(0);

	useLayoutEffect(() => {
		if (size != null) {
			setBox(size);
			return;
		}
		const el = wrapRef.current;
		if (!el) return;
		const measure = (): void => setBox(Math.min(el.clientWidth, el.clientHeight));
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [size]);

	const d = Math.max(1, box);
	const r = d / 2 - strokeWidth / 2;
	const circ = 2 * Math.PI * r;
	const pct = Math.min(1, Math.max(0, value));
	const dash = pct * circ;

	return (
		<div ref={wrapRef} className={className} style={{ position: "relative", width: "100%", height: "100%" }}>
			{d > 0 && (
				<svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} role="img" aria-label={`${Math.round(pct * 100)}%`}>
					<circle cx={d / 2} cy={d / 2} r={r} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
					<circle
						cx={d / 2}
						cy={d / 2}
						r={r}
						fill="none"
						stroke={color}
						strokeWidth={strokeWidth}
						strokeLinecap="round"
						strokeDasharray={`${dash} ${circ - dash}`}
						transform={`rotate(-90 ${d / 2} ${d / 2})`}
					/>
				</svg>
			)}
			{children && (
				<div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>{children}</div>
			)}
		</div>
	);
}
