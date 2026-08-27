import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../i18n/index.js";
import { CountUp } from "./count-up";

/**
 * Metric widget — reactbits CountUp rolling number + semantic delta tint
 * (kimi data-card pattern: 红=扣减/绿=增长). Minimal sparkline derived
 * from the value history.
 */
export function MetricCard({
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

	const fmt = (n: number): string => {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
		return String(Math.round(n));
	};

	const spark = history.map((v, i) => `${(i / Math.max(1, history.length - 1)) * 100},${100 - v * 10}`).join(" ");

	return (
		<div className="gui-widget-metric">
			<div className="gui-widget-metric-head">
				<span className="gui-widget-metric-label">{label}</span>
				<button
					type="button"
					className="gui-widget-metric-tick"
					title={t("widget refresh")}
					aria-label={t("widget refresh")}
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
				<CountUp value={value} format={fmt} />
			</div>
			<div className="gui-widget-metric-foot">
				<span className={`gui-widget-metric-delta${up ? "" : " gui-widget-metric-delta--down"}`}>
					{up ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(2)}%
				</span>
				<svg viewBox="0 0 100 40" className="gui-widget-metric-spark" aria-hidden="true">
					<polyline points={spark} fill="none" className="gui-widget-metric-spark-line" />
				</svg>
			</div>
		</div>
	);
}
