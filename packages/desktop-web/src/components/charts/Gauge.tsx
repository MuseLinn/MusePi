import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * Zero-dependency responsive semicircle gauge — the "market temperature"
 * dial under the finance card. Same anti-stretch contract as {@link Donut}:
 * the container is measured with a ResizeObserver and the arc/needle are drawn
 * in pixel coordinates against a 1:1 `viewBox`, so the semicircle stays a true
 * half-circle at any card size instead of being squashed by the fixed `100 60`
 * viewBox + `preserveAspectRatio="none"` pattern this replaced.
 *
 * Colors are CSS values (`var(--…)` works) so the dial tracks theme tokens.
 * The caller (finance `GaugeCard`) keeps its own head/value/status chrome;
 * this component renders only the dial.
 */

export interface GaugeProps {
	/** Current value, in `[min, max]` space. */
	value: number;
	/** Lower bound (default 0). */
	min?: number;
	/** Upper bound (default 100). */
	max?: number;
	/** Progress-arc color (CSS value). Default `var(--color-accent)`. */
	color?: string;
	/** Background track color. Default `var(--color-surface-hover)`. */
	trackColor?: string;
	/** Needle color. Default `var(--color-text)`. */
	needleColor?: string;
	/** Center pivot dot color. Default `var(--color-text)`. */
	pivotColor?: string;
	/** Render `min` / `max` scale labels under the arc (default true). */
	scale?: boolean;
	/** Scale label color. Default `var(--color-text-secondary)`. */
	scaleColor?: string;
	/** Fixed height in px. Omit to fill the container (measured clientHeight). */
	height?: number;
	/** Wrapper class — sizing/layout lives here. */
	className?: string;
}

export function Gauge({
	value,
	min = 0,
	max = 100,
	color = "var(--color-accent)",
	trackColor = "var(--color-surface-hover)",
	needleColor = "var(--color-text)",
	pivotColor = "var(--color-text)",
	scale = true,
	scaleColor = "var(--color-text-secondary)",
	height,
	className,
}: GaugeProps): ReactNode {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });

	useLayoutEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const measure = (): void => {
			const w = el.clientWidth;
			const h = el.clientHeight || height || 0;
			setSize({ w, h });
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [height]);

	const { w: W, h: H } = size;
	// Semicircle sweeps −180° (left) → 0° (right); value maps onto that arc.
	const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
	const cx = W / 2;
	const cy = H * 0.84;
	const r = Math.min(cx, cy) * 0.88;
	const angle = -Math.PI + t * Math.PI;
	const nx = cx + r * Math.cos(angle);
	const ny = cy + r * Math.sin(angle);

	const trackPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
	const arcPath = t > 0 ? `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${nx} ${ny}` : "";
	const stroke = r * 0.125;
	const needleW = Math.max(1, r * 0.035);
	const pivotR = Math.max(2.5, r * 0.06);
	const fontSize = r * 0.15;

	return (
		<div ref={wrapRef} className={className} style={height ? { height } : undefined}>
			{W > 0 && H > 0 && (
				<svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
					<path d={trackPath} fill="none" stroke={trackColor} strokeWidth={stroke} strokeLinecap="round" />
					{arcPath && <path d={arcPath} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" />}
					<line x1={cx} y1={cy} x2={nx} y2={ny} stroke={needleColor} strokeWidth={needleW} strokeLinecap="round" />
					<circle cx={cx} cy={cy} r={pivotR} fill={pivotColor} />
					{scale && (
						<>
							<text x={cx - r} y={cy + r * 0.28} textAnchor="middle" fontSize={fontSize} fill={scaleColor}>
								{min}
							</text>
							<text x={cx + r} y={cy + r * 0.28} textAnchor="middle" fontSize={fontSize} fill={scaleColor}>
								{max}
							</text>
						</>
					)}
				</svg>
			)}
		</div>
	);
}
