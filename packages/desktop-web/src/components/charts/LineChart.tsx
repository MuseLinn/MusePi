import type { ReactNode } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Zero-dependency responsive line chart.
 *
 * The one thing that matters here is the reason every hand-rolled SVG chart
 * in this repo is broken: `viewBox` + `preserveAspectRatio="none"` stretches
 * the geometry anisotropically — dots become ellipses and line angles distort.
 * This component measures its container with a ResizeObserver and renders in
 * **pixel coordinates** against a 1:1 `viewBox`, so the SVG scales uniformly
 * and the geometry stays true at any container width.
 *
 * Theme: colors are passed as CSS values — including `var(--…)` — so series
 * track the active accent/error tokens and the dark/light toggle for free.
 */

export interface LineChartSerie {
	/** Legend / tooltip label. */
	name: string;
	/** CSS color value; `var(--…)` works for theme tracking. */
	color: string;
	/** One value per x position; every serie must share the same length. */
	data: number[];
	/** Gradient fill below the line (default true). */
	fill?: boolean;
}

export interface LineChartProps {
	series: LineChartSerie[];
	/** x-axis labels, aligned to `serie.data`; rendered sparsely to avoid overlap. */
	labels?: string[];
	/** Fixed height in px; width follows the container. */
	height?: number;
	/** Data dots on every point (default true). */
	dots?: boolean;
	/** Horizontal gridlines + y-axis ticks (default true). */
	grid?: boolean;
	/** Y-axis ceiling; defaults to a nice round-up of the data max. */
	yMax?: number;
	/** Y-axis tick formatter (default `String`). */
	formatY?: (n: number) => string;
	className?: string;
}

const PAD = { top: 10, right: 8, bottom: 20, left: 44 } as const;

/** Round a value up to the nearest 1/1.5/2/2.5/3/4/5/6/8 × 10ⁿ for clean ticks. */
function niceCeil(v: number): number {
	if (!Number.isFinite(v) || v <= 0) return 1;
	const exp = Math.floor(Math.log10(v));
	const base = 10 ** exp;
	for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
		if (v <= m * base) return m * base;
	}
	return 10 * base;
}

export function LineChart({
	series,
	labels,
	height = 160,
	dots = true,
	grid = true,
	yMax,
	formatY = String,
	className,
}: LineChartProps): ReactNode {
	// SVG gradient ids are document-global — a per-instance prefix keeps N
	// concurrent charts from painting into each other's gradients.
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
	const max = yMax ?? niceCeil(Math.max(0, ...series.flatMap(s => s.data)));
	const H = height;
	const W = Math.max(1, width);

	const xAt = (i: number): number =>
		n <= 1 ? (W - PAD.left - PAD.right) / 2 + PAD.left : PAD.left + (i / (n - 1)) * (W - PAD.left - PAD.right);
	const yAt = (v: number): number => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);

	const linePoints = (data: number[]): string =>
		data.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ");
	const areaPath = (data: number[]): string => {
		if (n === 0) return "";
		const y0 = H - PAD.bottom;
		return `M${xAt(0).toFixed(2)},${y0} ${data.map((v, i) => `L${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ")} L${xAt(n - 1).toFixed(2)},${y0} Z`;
	};

	// Sparse x labels: show roughly every ceil(n/6)th plus the last, so 7 or
	// 30 points never produce overlapping date labels.
	const labelStep = Math.max(1, Math.ceil(n / 6));

	return (
		<div ref={wrapRef} className={className} style={{ width: "100%", height }}>
			{width > 0 && n > 0 && (
				<svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${n} points`}>
					<defs>
						{series.map((s, si) => (
							<linearGradient key={si} id={`${uid}-fill-${si}`} x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={s.color} stopOpacity="0.22" />
								<stop offset="100%" stopColor={s.color} stopOpacity="0" />
							</linearGradient>
						))}
					</defs>

					{grid &&
						[0, 0.25, 0.5, 0.75, 1].map(f => {
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

					{series.map(
						(s, si) =>
							s.fill !== false && <path key={`a${si}`} d={areaPath(s.data)} fill={`url(#${uid}-fill-${si})`} />,
					)}

					{series.map((s, si) => (
						<polyline
							key={`l${si}`}
							points={linePoints(s.data)}
							fill="none"
							stroke={s.color}
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					))}

					{dots &&
						series.map((s, si) =>
							s.data.map((v, i) => (
								<circle key={`${si}-${i}`} cx={xAt(i)} cy={yAt(v)} r="2.5" fill={s.color}>
									<title>{`${s.name} · ${labels?.[i] ?? ""} ${formatY(v)}`.trim()}</title>
								</circle>
							)),
						)}

					{labels?.map((label, i) =>
						i % labelStep === 0 || i === n - 1 ? (
							<text
								key={i}
								x={xAt(i)}
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
