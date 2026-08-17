import { t } from "../i18n/index.js";
import type { ReactNode } from "react";
import { useState } from "react";

/**
 * Ticker widget — FX/stock quote card: label + value + delta ▲▼ +
 * sparkline (kimi ticker pattern). Static sample data in M1; the daemon
 * widget.data proxy feeds real quotes in a later milestone.
 */
export function TickerCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const label = typeof data.label === "string" ? data.label : "TICKER";
	const value = typeof data.value === "string" ? data.value : "0";
	const delta = typeof data.delta === "number" ? data.delta : 0;
	const spark = Array.isArray(data.spark) ? (data.spark as number[]) : [1, 2, 3, 2.5];
	const up = delta >= 0;

	const min = Math.min(...spark);
	const max = Math.max(...spark);
	const range = max - min || 1;
	const pts = spark
		.map((v, i) => `${(i / Math.max(1, spark.length - 1)) * 100},${100 - ((v - min) / range) * 90 - 5}`)
		.join(" ");

	return (
		<div className="gui-widget-ticker">
			<div className="gui-widget-ticker-head">
				<span className="gui-widget-ticker-label">{label}</span>
				<span className={`gui-widget-ticker-delta${up ? "" : " gui-widget-ticker-delta--down"}`}>
					{up ? "▲" : "▼"} {Math.abs(delta).toFixed(4)}
				</span>
			</div>
			<div className="gui-widget-ticker-value">{value}</div>
			<svg viewBox="0 0 100 40" preserveAspectRatio="none" className="gui-widget-ticker-spark" aria-hidden="true">
				<polyline points={pts} fill="none" className="gui-widget-ticker-spark-line" />
			</svg>
			<div className="gui-widget-ticker-actions">
				<button type="button" className="gui-widget-ticker-btn" onClick={() => update({ value: "7.7945", delta: 0.0046 })}>
					{t("widget refresh")}
				</button>
			</div>
		</div>
	);
}
