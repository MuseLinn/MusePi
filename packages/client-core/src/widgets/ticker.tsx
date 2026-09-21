import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Sparkline } from "../components/charts/Sparkline";
import { t } from "../i18n/index.js";
import { widgetFetch } from "./fetch";

/** Real-time FX quote source (fx.tsx parity). */
const LIVE_API = "https://open.er-api.com/v6/latest/CNY";
/** Live refresh cadence (seconds) — matches the fx card. */
const REFRESH = 60;

function fmtValue(n: number): string {
	return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * Ticker widget — FX/stock quote card: label + value + delta ▲▼ +
 * sparkline (kimi ticker pattern). Live quotes via open.er-api.com (base
 * CNY, same source as the fx card): the code is derived from the label
 * ("EUR / CNY" → EUR) or an explicit `data.code`, and the card keeps the
 * last shown quote when the network is down or the code has no rate.
 */
export function TickerCard({
	data,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const label = typeof data.label === "string" && data.label !== "" ? data.label : "TICKER";
	// Live quote code: explicit data.code, else the leading currency of the
	// label. A non-FX label (no code, no rate) stays on its static defaults.
	const code =
		(typeof data.code === "string" && data.code !== "" ? data.code : label.split("/")[0]?.trim().toUpperCase()) ?? "";
	const initialValue = typeof data.value === "string" ? data.value : "0";
	const initialDelta = typeof data.delta === "number" ? data.delta : 0;
	const initialSpark = Array.isArray(data.spark) ? (data.spark as number[]) : [1, 2, 3, 2.5];

	const [value, setValue] = useState(initialValue);
	const [delta, setDelta] = useState(initialDelta);
	const [spark, setSpark] = useState<number[]>(initialSpark);
	const prevRef = useRef<number | null>(null);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		if (!code) return;
		let cancelled = false;
		let timer: number | undefined;
		const refresh = async (): Promise<void> => {
			try {
				const res = await widgetFetch(LIVE_API, { cache: "no-store" });
				const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
				if (json?.result !== "success" || !json.rates || json.rates[code] == null) return;
				const v = 1 / json.rates[code];
				if (cancelled) return;
				const prevV = prevRef.current;
				setValue(fmtValue(v));
				setDelta(prevV == null ? 0 : v - prevV);
				prevRef.current = v;
				setSpark(s => [...s.slice(-39), v]);
			} catch {
				// Network down / no rate for this code: keep the last quote.
			}
		};
		void refresh();
		timer = Number(setInterval(() => void refresh(), REFRESH * 1000));
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [code, tick]);

	const up = delta >= 0;

	return (
		<div className="gui-widget-ticker">
			<div className="gui-widget-ticker-head">
				<span className="gui-widget-ticker-label">{label}</span>
				<span className={`gui-widget-ticker-delta${up ? "" : " gui-widget-ticker-delta--down"}`}>
					{up ? "▲" : "▼"} {Math.abs(delta).toFixed(4)}
				</span>
			</div>
			<div className="gui-widget-ticker-value">{value}</div>
			<Sparkline data={spark} color="var(--color-accent)" strokeWidth={1.5} className="gui-widget-ticker-spark" />
			<div className="gui-widget-ticker-actions">
				<button
					type="button"
					className="gui-widget-ticker-btn"
					disabled={code === ""}
					onClick={() => setTick(n => n + 1)}
				>
					{t("widget refresh")}
				</button>
			</div>
		</div>
	);
}
