import type { ReactNode } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Zero-dependency responsive sparkline — the mini trend strip under ticker /
 * metric / fx / stocks cards. Same anti-stretch contract as {@link LineChart}:
 * the container is measured with a ResizeObserver and the line is drawn in
 * pixel coordinates against a 1:1 `viewBox`, so the geometry stays true at any
 * container size instead of being squashed by `preserveAspectRatio="none"`.
 *
 * Unlike LineChart there is no axis, grid or legend — the strip is filled with
 * a min/max-normalized polyline and an optional solid area fill. Colors are
 * passed as CSS values (`var(--…)` works; fx/stocks pass `var(--gui-*-dir)` so
 * the up/down tint inherited from the row tracks for free).
 */

export interface SparklineProps {
	/** Y values, one per point. */
	data: number[];
	/** Fixed y-domain [min, max]. Values outside it are clipped by the viewBox
	 *  (keeps an oscillation centered on a fixed baseline). Omit to auto-normalize
	 *  to the data's own min/max. */
	domain?: [number, number];
	/** Line color (CSS value, `var(--…)` ok). Default `var(--color-accent)`. */
	color?: string;
	/** Fixed height in px. Omit to fill the container (measured clientHeight). */
	height?: number;
	/** Area fill below the line (default false). */
	fill?: boolean;
	/** Fill color; defaults to `color`. */
	fillColor?: string;
	/** Fill opacity (default 0.09 — matches the fx/stocks cards). */
	fillOpacity?: number;
	/** Line stroke width (default 1.5). */
	strokeWidth?: number;
	/** Wrapper class — sizing/layout lives here (`flex:1`, fixed width, etc.). */
	className?: string;
}

/** Breathing room so the line never kisses the container edge. */
const XPAD = 1;
const YPAD = 2;

export function Sparkline({
	data,
	domain,
	color = "var(--color-accent)",
	height,
	fill = false,
	fillColor,
	fillOpacity = 0.09,
	strokeWidth = 1.5,
	className,
}: SparklineProps): ReactNode {
	const uid = useId().replace(/:/g, "");
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });

	useLayoutEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const measure = (): void => {
			const w = el.clientWidth;
			// A flex:1 strip reports its stretched height; a fixed-height strip
			// falls back to the `height` prop. Either way the viewBox is 1:1.
			const h = el.clientHeight || height || 0;
			setSize({ w, h });
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [height]);

	const { w: W, h: H } = size;
	const n = data.length;
	const [dMin, dMax] = domain ?? [Math.min(...data), Math.max(...data)];
	const range = dMax - dMin || 1;

	const xAt = (i: number): number => (n <= 1 ? W / 2 : XPAD + (i / (n - 1)) * (W - XPAD * 2));
	const yAt = (v: number): number => YPAD + (1 - (v - dMin) / range) * (H - YPAD * 2);

	const points = data.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ");
	const bottom = H - YPAD;
	const areaPath =
		fill && n > 1
			? `M${xAt(0).toFixed(2)},${bottom.toFixed(2)} ${data
					.map((v, i) => `L${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`)
					.join(" ")} L${xAt(n - 1).toFixed(2)},${bottom.toFixed(2)} Z`
			: "";

	return (
		<div ref={wrapRef} className={className} style={height ? { height } : undefined}>
			{W > 0 && H > 0 && n >= 2 && (
				<svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
					{fill && (
						<>
							<defs>
								<linearGradient id={`${uid}-spark-fill`} x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stopColor={fillColor ?? color} stopOpacity={fillOpacity} />
									<stop offset="100%" stopColor={fillColor ?? color} stopOpacity="0" />
								</linearGradient>
							</defs>
							<path d={areaPath} fill={`url(#${uid}-spark-fill)`} />
						</>
					)}
					<polyline
						points={points}
						fill="none"
						stroke={color}
						strokeWidth={strokeWidth}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			)}
		</div>
	);
}
