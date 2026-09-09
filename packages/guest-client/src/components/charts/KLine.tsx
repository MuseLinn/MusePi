import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * Zero-dependency responsive candlestick (K线) chart — the price panel from
 * the finance card's KlineCard. Renders OHLC candles + optional volume bars +
 * MA5/MA20 overlays. Same anti-stretch contract: measured container, pixel
 * coordinates, 1:1 `viewBox`. The price area fills the container (flex:1),
 * so the container's height is measured and only falls back to `height` when
 * it reports zero.
 *
 * A-share convention: red = up (close ≥ open), green = down — colors default
 * to the semantic tokens so the theme toggle and the danger/success accents
 * track for free. Candles carry a native `<title>` so hovering a bar shows its
 * OHLC on any pointer device (no JS tooltip).
 */

export interface KLineCandle {
	o: number;
	h: number;
	l: number;
	c: number;
	v?: number;
}

export interface KLineProps {
	candles: KLineCandle[];
	/** Fallback height when the container reports none. Default 70. */
	height?: number;
	/** Render the volume strip (default true). */
	volume?: boolean;
	/** MA5 overlay (default true). */
	ma5?: boolean;
	/** MA20 overlay (default true). */
	ma20?: boolean;
	/** Up (red) candle color. Default `var(--color-danger)`. */
	upColor?: string;
	/** Down (green) candle color. Default `var(--color-success)`. */
	downColor?: string;
	className?: string;
}

/** Fixed brand color for the MA5 line (gold reads on both themes). */
const MA5_COLOR = "#ffb224";

export function KLine({
	candles,
	height = 70,
	volume = true,
	ma5 = true,
	ma20 = true,
	upColor = "var(--color-danger, #e5484d)",
	downColor = "var(--color-success, #30a46c)",
	className,
}: KLineProps): ReactNode {
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
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [height]);

	const { w: W, h: H } = size;
	const n = candles.length;
	const volH = volume ? H * 0.2 : 0;
	const priceH = H - volH;
	const min = Math.min(...candles.flatMap(c => [c.l, c.o, c.c]));
	const max = Math.max(...candles.flatMap(c => [c.h, c.o, c.c]));
	const range = max - min || 1;

	const xAt = (i: number): number => (i / Math.max(1, n - 1)) * W;
	const yAt = (v: number): number => priceH - ((v - min) / range) * (priceH - 4) - 2;
	const cw = (W / n) * 0.62;

	const maLine = (win: number): string =>
		candles
			.map((_, i) => {
				if (i < win - 1) return null;
				const slice = candles.slice(i - win + 1, i + 1);
				const avg = slice.reduce((a, c) => a + c.c, 0) / win;
				return `${xAt(i).toFixed(2)},${yAt(avg).toFixed(2)}`;
			})
			.filter((p): p is string => p != null)
			.join(" ");

	return (
		<div ref={wrapRef} className={className} style={{ width: "100%" }}>
			{W > 0 && H > 0 && n > 0 && (
				<svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${n} candles`}>
					{candles.map((c, i) => {
						const up = c.c >= c.o;
						const color = up ? upColor : downColor;
						const cx = xAt(i);
						const v = Number.isFinite(c.v) ? (c.v ?? 0) : 0;
						return (
							<g key={i}>
								<title>{`O ${c.o.toFixed(2)}  H ${c.h.toFixed(2)}  L ${c.l.toFixed(2)}  C ${c.c.toFixed(2)}  V ${v}`}</title>
								<line x1={cx} y1={yAt(c.h)} x2={cx} y2={yAt(c.l)} stroke={color} strokeWidth={0.5} />
								<rect
									x={cx - cw / 2}
									y={Math.min(yAt(c.o), yAt(c.c))}
									width={cw}
									height={Math.max(1.2, Math.abs(yAt(c.o) - yAt(c.c)))}
									fill={color}
								/>
								{volume && (
									<rect
										x={cx - cw / 4}
										y={priceH + 2 + (1 - v / 100) * (volH - 2)}
										width={cw / 2}
										height={(v / 100) * (volH - 2)}
										fill={color}
										opacity={0.55}
									/>
								)}
							</g>
						);
					})}
					{ma5 && <polyline points={maLine(5)} fill="none" stroke={MA5_COLOR} strokeWidth={0.6} />}
					{ma20 && (
						<polyline
							points={maLine(20)}
							fill="none"
							stroke="var(--color-accent)"
							strokeWidth={0.6}
							strokeDasharray="1.4 1"
						/>
					)}
				</svg>
			)}
		</div>
	);
}
