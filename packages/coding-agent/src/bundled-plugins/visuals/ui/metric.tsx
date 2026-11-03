/**
 * Metric card renderer (plugin-contributed widget).
 *
 * Compiled by the daemon and imported by the GUI through a blob module, so it
 * receives React from `window.MusePiReact` (the compiler's `React` define).
 * It imports nothing from the host: a second copy of React or client-core in
 * the bundle would break hook identity, and this card only needs a number, a
 * delta and a sparkline. Text comes from the host's shared i18n table.
 */
import type { ReactNode } from "react";

declare const React: {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => ReactNode;
	Fragment: unknown;
	useState: <T>(initial: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
	useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void;
	useRef: <T>(initial: T) => { current: T };
};

declare function requestAnimationFrame(callback: (time: number) => void): number;
declare function cancelAnimationFrame(handle: number): void;
declare const performance: { now(): number };
declare const window: {
	MusePiHostModules?: { i18n?: { t(key: string): string } };
};

const { useState, useEffect, useRef } = React;

function refreshLabel(): string {
	return window.MusePiHostModules?.i18n?.t("settings.widgetRefresh") ?? "Refresh";
}

/** Number-roll counter, inlined so the plugin owns no second dependency. */
function CountUp({ value, duration = 500 }: { value: number; duration?: number }): ReactNode {
	const [display, setDisplay] = useState<number>(value);
	const prevRef = useRef<number>(value);
	useEffect(() => {
		const prev = prevRef.current;
		prevRef.current = value;
		if (prev === value) {
			setDisplay(value);
			return;
		}
		const start = performance.now();
		let raf = 0;
		const step = (now: number): void => {
			const k = Math.min(1, (now - start) / duration);
			const eased = 1 - (1 - k) ** 3;
			setDisplay(prev + (value - prev) * eased);
			if (k < 1) raf = requestAnimationFrame(step);
			else setDisplay(value);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [value, duration]);
	const n = Math.round(display);
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** Minimal sparkline: a polyline in the card's accent, no chart dependency. */
function Spark({ data }: { data: number[] }): ReactNode {
	const w = 120;
	const h = 30;
	const values = data.length > 1 ? data : [0, 0];
	const min = Math.min(...values);
	const max = Math.max(...values);
	const span = max - min || 1;
	const points = values
		.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`)
		.join(" ");
	return (
		<svg
			className="gui-widget-metric-spark"
			viewBox={`0 0 ${w} ${h}`}
			width="100%"
			height={h}
			preserveAspectRatio="none"
		>
			<polyline
				points={points}
				fill="none"
				stroke="var(--color-accent)"
				strokeWidth={1.4}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

export default function MetricCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const [history, setHistory] = useState<number[]>(
		Array.isArray(data.history) ? (data.history as number[]) : [3, 4, 5, 4, 6, 5, 7, 6, 8],
	);
	const value = typeof data.value === "number" ? data.value : 0;
	const delta = typeof data.delta === "number" ? data.delta : 0;
	const label = typeof data.label === "string" ? data.label : "metric";
	const up = delta >= 0;

	return (
		<div className="gui-widget-metric">
			<div className="gui-widget-metric-head">
				<span className="gui-widget-metric-label">{label}</span>
				<button
					type="button"
					className="gui-widget-metric-tick"
					title={refreshLabel()}
					aria-label={refreshLabel()}
					onClick={() => {
						const next = value + Math.round(Math.random() * 500 - 200);
						setHistory(prev => [...prev.slice(1), next / 1000 + 3]);
						update({ value: next, delta: (next - value) / Math.max(1, value) });
					}}
				>
					↻
				</button>
			</div>
			<div className="gui-widget-metric-value">
				<CountUp value={value} />
			</div>
			<div className="gui-widget-metric-foot">
				<span className={`gui-widget-metric-delta${up ? "" : " gui-widget-metric-delta--down"}`}>
					{up ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(2)}%
				</span>
				<Spark data={history} />
			</div>
		</div>
	);
}
