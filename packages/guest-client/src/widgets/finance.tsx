import type { ReactNode } from "react";
import { useState } from "react";
import { Gauge } from "../components/charts/Gauge";
import { KLine } from "../components/charts/KLine";
import { Sparkline } from "../components/charts/Sparkline";
import { t } from "../i18n/index.js";

/**
 * kimi 每日财经 component set: A股市场温度 (gauge), 超级图表 K线
 * (kline), 热力墙 (heatwall), 指数磁带 (indextape). All are responsive
 * (flex/percent layouts fill the card at any size).
 */

// ── Gauge · A股市场温度 ────────────────────────────────────────────
export function GaugeCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const value = typeof data.value === "number" ? Math.max(0, Math.min(100, data.value)) : 70;
	const label = typeof data.label === "string" ? data.label : "温度";
	const status = typeof data.status === "string" ? data.status : "";
	return (
		<div className="gui-widget-gauge">
			<div className="gui-widget-gauge-head">
				<span className="gui-widget-gauge-title">{label}</span>
				<span className="gui-widget-gauge-sub">{t("widget gauge sub")}</span>
			</div>
			<div className="gui-widget-gauge-body">
				<Gauge value={value} className="gui-widget-gauge-svg" />
				<div className="gui-widget-gauge-value">{Math.round(value)}</div>
				{status && <div className="gui-widget-gauge-status">{status}</div>}
			</div>
		</div>
	);
}

// ── Kline · K线图（超级图表）───────────────────────────────────────
interface Ohlc {
	o: number;
	h: number;
	l: number;
	c: number;
	v: number;
}

function isFiniteNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/** Rows with finite open/high/low/close are renderable (volume optional). */
function isValidOhlc(c: unknown): c is Ohlc {
	if (typeof c !== "object" || c === null) return false;
	const r = c as Record<string, unknown>;
	return isFiniteNum(r.o) && isFiniteNum(r.h) && isFiniteNum(r.l) && isFiniteNum(r.c);
}

/** Deterministic sample candles (kimi K-STATION look without network). */
function sampleCandles(n: number, start: number, drift = 0.4): Ohlc[] {
	const out: Ohlc[] = [];
	let price = start;
	for (let i = 0; i < n; i++) {
		const open = price;
		const close = Math.max(100, open + (Math.random() - 0.48) * drift * 20);
		const hi = Math.max(open, close) + Math.random() * drift * 6;
		const lo = Math.min(open, close) - Math.random() * drift * 6;
		out.push({ o: open, h: hi, l: lo, c: close, v: 40 + Math.random() * 60 });
		price = close;
	}
	return out;
}

export function klineDefaults(): Record<string, unknown> {
	const candles = sampleCandles(40, 470);
	return {
		symbol: "腾讯控股",
		price: 478.8,
		delta: -0.08,
		candles,
		stocks: ["腾讯控股", "阿里巴巴", "贵州茅台", "宁德时代"],
	};
}

export function KlineCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	// Agent-filled candles can carry a missing/NaN field (the schema only
	// says `candles: [...]`) — drop rows without finite OHLC and zero-fill
	// volume so SVG geometry never receives NaN.
	const candles = (Array.isArray(data.candles) ? data.candles : [])
		.filter(isValidOhlc)
		.map(c => (Number.isFinite(c.v) ? c : { ...c, v: 0 }));
	const stocks = Array.isArray(data.stocks) ? (data.stocks as string[]) : [];
	const [active, setActive] = useState(0);
	const price = typeof data.price === "number" ? data.price : 0;
	const delta = typeof data.delta === "number" ? data.delta : 0;
	const symbol = stocks[active] ?? (typeof data.symbol === "string" ? data.symbol : "—");
	if (candles.length === 0) {
		return <div className="gui-widget-kline-empty">{t("widget kline empty")}</div>;
	}
	const last = candles[candles.length - 1];
	return (
		<div className="gui-widget-kline">
			<div className="gui-widget-kline-tabs">
				{stocks.map((s, i) => (
					<button
						type="button"
						key={s}
						className={`gui-widget-kline-tab${active === i ? " gui-widget-kline-tab--active" : ""}`}
						onClick={() => setActive(i)}
					>
						{s}
					</button>
				))}
				<span className="gui-widget-kline-pricedelta">
					{price.toFixed(2)} {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(2)}%
				</span>
			</div>
			<div className="gui-widget-kline-data">
				<span>{t("widget kline ohlc")}</span>
				<span>
					开 {last.o.toFixed(2)} 高 {last.h.toFixed(2)} 低 {last.l.toFixed(2)} 收 {last.c.toFixed(2)}
				</span>
			</div>
			<KLine candles={candles} className="gui-widget-kline-svg" />
			<div className="gui-widget-kline-foot">
				<span>MA5 · MA20 · {t("widget kline vol")}</span>
				<span>{t("widget kline range")}</span>
			</div>
		</div>
	);
}

// ── Heatwall · 热力墙 ──────────────────────────────────────────────
export interface HeatTile {
	name: string;
	delta?: number;
}

export function heatwallDefaults(): Record<string, unknown> {
	return {
		tiles: [
			{ name: "工商银行", delta: -0.53 },
			{ name: "中国石油", delta: 0.84 },
			{ name: "宁德时代", delta: 0.02 },
			{ name: "贵州茅台", delta: 0.05 },
			{ name: "中芯国际", delta: 3.5 },
			{ name: "招商银行", delta: -0.44 },
			{ name: "中国平安", delta: -0.22 },
			{ name: "紫金矿业", delta: 1.88 },
			{ name: "比亚迪", delta: 0.66 },
			{ name: "长江电力", delta: 0 },
			{ name: "美的集团", delta: -2.13 },
			{ name: "中国石化", delta: 0.39 },
			{ name: "立讯精密", delta: 0.1 },
			{ name: "中信证券", delta: 0.2 },
			{ name: "兴业银行", delta: -0.12 },
			{ name: "恒瑞医药", delta: 0.05 },
			{ name: "京东方A", delta: 1.84 },
			{ name: "平安银行", delta: 0.08 },
		],
	};
}

export function HeatwallCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const raw = Array.isArray(data.tiles) ? (data.tiles as unknown[]) : [];
	const tiles = raw.filter(
		(x): x is HeatTile => typeof x === "object" && x !== null && typeof (x as HeatTile).name === "string",
	);
	return (
		<div className="gui-widget-heatwall">
			<div className="gui-widget-heatwall-head">
				<span className="gui-widget-heatwall-title">HEAT WALL · {t("widget heatwall sub")}</span>
				<span className="gui-widget-heatwall-count">{tiles.length} · REFRESH</span>
			</div>
			<div className="gui-widget-heatwall-grid">
				{tiles.map((tl, i) => {
					const d = typeof tl.delta === "number" ? tl.delta : 0;
					const up = d > 0;
					const level = Math.min(3, Math.floor(Math.abs(d) / 0.8));
					return (
						<div
							key={`${tl.name}-${i}`}
							className={`gui-widget-heatwall-tile gui-widget-heatwall-tile--${up ? "up" : "down"}-${level}${d === 0 ? " gui-widget-heatwall-tile--flat" : ""}`}
							title={`${tl.name} ${d > 0 ? "+" : ""}${d.toFixed(2)}%`}
						>
							<span className="gui-widget-heatwall-name">{tl.name}</span>
							<span className="gui-widget-heatwall-delta">
								{d === 0 ? "0.00" : `${d > 0 ? "+" : ""}${d.toFixed(2)}%`}
							</span>
						</div>
					);
				})}
			</div>
			<div className="gui-widget-heatwall-foot">{t("widget heatwall foot")}</div>
		</div>
	);
}

// ── Indextape · 指数磁带 ───────────────────────────────────────────
export function indextapeDefaults(): Record<string, unknown> {
	return {
		indices: ["上证", "深证", "恒生"],
		value: 3940.84,
		delta: 1.02,
		series: [3800, 3850, 3830, 3900, 3920, 3880, 3940, 3930, 3955, 3940],
	};
}

export function IndextapeCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const indices = Array.isArray(data.indices) ? (data.indices as string[]) : [];
	// Agent-filled series may carry non-finite entries — keep the geometry
	// math (min/max/polyline) on finite numbers only.
	const series = (Array.isArray(data.series) ? (data.series as unknown[]) : [1, 2, 3, 4]).filter(isFiniteNum);
	const [active, setActive] = useState(0);
	const value = typeof data.value === "number" ? data.value : 0;
	const delta = typeof data.delta === "number" ? data.delta : 0;
	const idx = indices[active] ?? "上证";
	return (
		<div className="gui-widget-indextape">
			<div className="gui-widget-indextape-tabs">
				{indices.map((s, i) => (
					<button
						type="button"
						key={s}
						className={`gui-widget-indextape-tab${active === i ? " gui-widget-indextape-tab--active" : ""}`}
						onClick={() => setActive(i)}
					>
						{s}
					</button>
				))}
			</div>
			<div className="gui-widget-indextape-head">
				<span className="gui-widget-indextape-title">INDEX TAPE · {idx} · DAILY</span>
				<span className="gui-widget-indextape-value">
					{value.toLocaleString()}{" "}
					<b className={delta >= 0 ? "" : "gui-widget-indextape-down"}>
						{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(2)}%
					</b>
				</span>
			</div>
			<Sparkline data={series} height={40} strokeWidth={1.2} className="gui-widget-indextape-svg" />
			<div className="gui-widget-indextape-foot">{t("widget indextape foot")}</div>
		</div>
	);
}
