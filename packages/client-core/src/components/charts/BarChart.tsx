import type { ReactNode } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Zero-dependency responsive stacked bar chart.
 *
 * Same pixel-coordinate contract as {@link LineChart}: ResizeObserver measures
 * the container, geometry renders against a 1:1 viewBox, and colors are CSS
 * values (`var(--…)` works) so bars track the accent/theme tokens. Multiple
 * series stack bottom-up per x position — the daily token trend, or any
 * per-category breakdown over time.
 */

export interface BarChartSerie {
	/** Legend / tooltip label. */
	name: string;
	/** CSS color value; `var(--…)` works for theme tracking. */
	color: string;
	/** One value per x position; every serie must share the same length. */
	data: number[];
}

export interface BarChartProps {
	/** Series stacked bottom-up, in draw order. */
	series: BarChartSerie[];
	/** x-axis labels, aligned to `serie.data`; rendered sparsely. */
	labels?: string[];
	/** Fixed height px; width follows the container. */
	height?: number;
	/** Y-axis ceiling; defaults to a nice round-up of the max column total. */
	yMax?: number;
	/** Y-axis tick formatter. */
	formatY?: (n: number) => string;
	/** Gap between bars, 0–1 as a fraction of the bar slot (default 0.25). */
	gap?: number;
	className?: string;
}

const PAD = { top: 10, right: 8, bottom: 20, left: 44 } as const;

function niceCeil(v: number): number {
	if (!Number.isFinite(v) || v <= 0) return 1;
	const exp = Math.floor(Math.log10(v));
	const base = 10 ** exp;
	for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
		if (v <= m * base) return m * base;
	}
	return 10 * base;
}

export function BarChart({
	series,
	labels,
	height = 160,
	yMax,
	formatY = String,
	gap = 0.25,
	className,
}: BarChartProps): ReactNode {
	const uid = useId().replace(/:/g, "");
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);

	useLayoutEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const measure = (): void => setWidth(el.clientWidth);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const n = series[0]?.data.length ?? 0;
	const totalAt = (i: number): number => series.reduce((s, se) => s + (se.data[i] ?? 0), 0);
	const max = yMax ?? niceCeil(Math.max(0, ...Array.from({ length: n }, (_, i) => totalAt(i))));
	const H = height;
	const W = Math.max(1, width);

	const plotW = W - PAD.left - PAD.right;
	const plotH = H - PAD.top - PAD.bottom;
	const slotW = n > 0 ? plotW / n : 0;
	const barW = slotW * (1 - gap);
	const xAt = (i: number): number => PAD.left + slotW * i + (slotW - barW) / 2;
	const yAt = (v: number): number => PAD.top + (1 - v / max) * plotH;

	const labelStep = Math.max(1, Math.ceil(n / 6));

	return (
		<div ref={wrapRef} className={className} style={{ width: "100%", height }}>
			{width > 0 && n > 0 && (
				<svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${n} bars`}>
					{[0, 0.25, 0.5, 0.75, 1].map(f => {
						const gy = yAt(max * f);
						return (
							<g key={f}>
								<line
									x1={PAD.left}
									x2={W - PAD.right}
									y1={gy}
									y2={gy}
									stroke="var(--color-border)"
									strokeOpacity="0.35"
									strokeWidth="1"
								/>
								<text
									x={PAD.left - 8}
									y={gy + 3}
									textAnchor="end"
									style={{ fontSize: 9, fill: "var(--color-text-faint)" }}
								>
									{formatY(max * f)}
								</text>
							</g>
						);
					})}

					{Array.from({ length: n }, (_, i) => {
						let acc = 0;
						return series.map((se, si) => {
							const v = se.data[i] ?? 0;
							if (v <= 0) return null;
							const yBottom = yAt(acc + v);
							const yTop = yAt(acc);
							acc += v;
							return (
								<rect
									key={`${i}-${si}`}
									x={xAt(i)}
									y={yBottom}
									width={barW}
									height={Math.max(0.5, yTop - yBottom)}
									fill={se.color}
									rx={1}
								>
									<title>{`${se.name} · ${labels?.[i] ?? ""} ${formatY(v)}`.trim()}</title>
								</rect>
							);
						});
					})}

					{labels?.map((label, i) =>
						i % labelStep === 0 || i === n - 1 ? (
							<text
								key={i}
								x={xAt(i) + barW / 2}
								y={H - 6}
								textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
								style={{ fontSize: 9, fill: "var(--color-text-faint)" }}
							>
								{label}
							</text>
						) : null,
					)}
				</svg>
			)}
		</div>
	);
}
