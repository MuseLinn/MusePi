import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { SlidingNumber } from "../lib/sliding-number.js";
import { widgetFetch } from "./fetch";
import { CharTexture } from "./texture";

/**
 * Live FX card — ported from the kimiwork "实时汇率" widget
 * (widget_f05f5dc6/workspace/index.html). Real rates: open.er-api.com
 * (base CNY, refreshed every 60s + on visibility return) and a 30-day
 * frankfurter.dev history series (cached per-day in localStorage). Rows:
 * pair + unit note, SVG sparkline, ¥ rate, ▲/▼ vs yesterday.
 */
export interface FxPair {
	code: string;
	/** Unit multiplier (100 日元 → 1 unit). */
	unit: number;
	note: string;
}

export function fxDefaults(): Record<string, unknown> {
	return {
		chip: "FX · 1 MIN",
		title: "汇率",
		pairs: [
			{ code: "EUR", unit: 1, note: "1 欧元" },
			{ code: "USD", unit: 1, note: "1 美元" },
			{ code: "JPY", unit: 100, note: "100 日元" },
			{ code: "KRW", unit: 100, note: "100 韩元" },
		],
		refresh: 60,
	};
}

const LIVE_API = "https://open.er-api.com/v6/latest/CNY";
const HIST_KEY = "omp-fx-hist30-v2";
const REFRESH = 60;

function dstr(d: Date): string {
	return d.toISOString().slice(0, 10);
}
function fmt(n: number, d: number): string {
	return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function sparkSvg(points: number[]): string {
	if (!points || points.length < 2) return "";
	let lo = Infinity;
	let hi = -Infinity;
	points.forEach(v => {
		lo = Math.min(lo, v);
		hi = Math.max(hi, v);
	});
	const span = hi - lo || hi * 0.001 || 1;
	const pts = points.map((v, i) => {
		const x = (i / (points.length - 1)) * 100;
		const y = 2.5 + (1 - (v - lo) / span) * 16;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	return (
		'<svg viewBox="0 0 100 22" preserveAspectRatio="none">' +
		`<polygon class="gui-fx-spark-fill" points="0,22 ${pts.join(" ")} 100,22" />` +
		`<polyline fill="none" stroke-width="1.4" vector-effect="non-scaling-stroke" points="${pts.join(" ")}" />` +
		"</svg>"
	);
}

interface FxRow {
	code: string;
	note: string;
	cur: number | null;
	series: number[];
	delta: { cls: "up" | "down" | "flat"; text: string } | null;
	dir: "up" | "down" | "";
}

export function FxCard({
	data,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const rawPairs = Array.isArray(data.pairs) ? (data.pairs as FxPair[]) : [];
	const pairs = rawPairs.length > 0 ? rawPairs : (fxDefaults().pairs as FxPair[]);
	const chip = typeof data.chip === "string" && data.chip !== "" ? data.chip : "FX · 1 MIN";
	const title = typeof data.title === "string" && data.title !== "" ? data.title : "汇率";

	const rowsElRef = useRef<HTMLDivElement | null>(null);
	const [status, setStatus] = useState("加载中…");
	const [dotCls, setDotCls] = useState(" gui-fx-dot--loading");
	const [rows, setRows] = useState<FxRow[]>([]);

	useEffect(() => {
		let hist: Record<string, number[]> | null = null;
		let live: Record<string, number> | null = null;
		let countdown = REFRESH;
		let cancelled = false;

		const render = () => {
			if (cancelled) return;
			const rows: FxRow[] = [];
			for (const p of pairs) {
				const daily = hist?.[p.code] || [];
				const cur = live && live[p.code] != null ? live[p.code] : daily.length ? daily[daily.length - 1] : null;
				const series = cur != null ? daily.concat([cur]) : daily;
				let delta: { cls: "up" | "down" | "flat"; text: string } | null = null;
				let dir: "up" | "down" | "" = "";
				if (cur != null && daily.length) {
					const prev = daily[daily.length - 1];
					const d = cur - prev;
					const cls = Math.abs(d) < 1e-5 ? "flat" : d > 0 ? "up" : "down";
					dir = cls === "flat" ? "" : cls;
					const arrow = cls === "flat" ? "·" : d > 0 ? "▲" : "▼";
					delta = { cls, text: `${arrow} ${fmt(Math.abs(d), 4)}` };
				}
				rows.push({ code: p.code, note: p.note, cur, series, delta, dir });
			}
			setRows(rows);
		};

		const loadHistory = async () => {
			try {
				const cached = JSON.parse(localStorage.getItem(HIST_KEY) ?? "null");
				if (cached && cached.day === dstr(new Date()) && cached.series) {
					hist = cached.series;
					return;
				}
			} catch {
				/* ignore */
			}
			try {
				const end = new Date();
				const start = new Date(Date.now() - 30 * 864e5);
				const url = `https://api.frankfurter.dev/v1/${dstr(start)}..${dstr(end)}?base=CNY&symbols=${pairs.map(p => p.code).join(",")}`;
				const res = await widgetFetch(url, { cache: "no-store" });
				const data = (await res.json()) as { rates?: Record<string, Record<string, number>> };
				if (!data?.rates) throw new Error("no history");
				const days = Object.keys(data.rates).sort();
				const series: Record<string, number[]> = {};
				for (const p of pairs) {
					series[p.code] = days
						.map(d => data.rates![d][p.code])
						.filter(v => v > 0)
						.map(v => Number(((1 / v) * p.unit).toFixed(5)));
				}
				hist = series;
				try {
					localStorage.setItem(HIST_KEY, JSON.stringify({ day: dstr(new Date()), series }));
				} catch {
					/* ignore */
				}
			} catch {
				/* history optional */
			}
		};

		const fetchLive = async () => {
			if (cancelled) return;
			setStatus("刷新中…");
			setDotCls(" gui-fx-dot--loading");
			try {
				const res = await widgetFetch(LIVE_API, { cache: "no-store" });
				const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
				if (data?.result !== "success" || !data.rates) throw new Error("bad payload");
				const vals: Record<string, number> = {};
				for (const p of pairs) {
					if (data.rates[p.code]) vals[p.code] = Number(((1 / data.rates[p.code]) * p.unit).toFixed(5));
				}
				live = vals;
				if (!cancelled) {
					render();
					const t = new Date();
					const hh = String(t.getHours()).padStart(2, "0");
					const mm = String(t.getMinutes()).padStart(2, "0");
					const ss = String(t.getSeconds()).padStart(2, "0");
					setStatus(`更新于 ${hh}:${mm}:${ss} · 每分钟自动刷新`);
					setDotCls("");
				}
			} catch {
				if (!cancelled) {
					setStatus("获取失败 · 显示上次数据，每分钟自动重试");
					setDotCls(" gui-fx-dot--err");
				}
			}
			countdown = REFRESH;
		};

		loadHistory().then(() => {
			if (!cancelled) {
				render();
				fetchLive();
			}
		});
		const iv = setInterval(() => {
			countdown -= 1;
			if (countdown <= 0) void fetchLive();
		}, 1000);
		const onVis = () => {
			if (!document.hidden && countdown < REFRESH - 5) void fetchLive();
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			cancelled = true;
			clearInterval(iv);
			document.removeEventListener("visibilitychange", onVis);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="gui-fx">
			<CharTexture className="gui-fx-tex" seed={7} />
			<header className="gui-fx-head">
				<span className="gui-fx-chip">{chip}</span>
				<span className="gui-fx-title">{title}</span>
			</header>
			<section className="gui-fx-rows" ref={rowsElRef}>
				{rows.map(r => (
					<div key={r.code} className={`gui-fx-row${r.dir ? ` gui-fx-row--${r.dir}` : ""}`}>
						<div className="gui-fx-ident">
							<span className="gui-fx-pair">{r.code} / CNY</span>
							<span className="gui-fx-unit">{r.note}</span>
						</div>
						<div
							className="gui-fx-spark"
							title="近 30 日走势"
							dangerouslySetInnerHTML={{ __html: sparkSvg(r.series) }}
						/>
						<div className="gui-fx-ratebox">
							<div className="gui-fx-rate">
								{r.cur == null ? (
									"--"
								) : (
									<>
										<span className="gui-fx-currency">¥</span>
										<SlidingNumber value={r.cur} decimals={4} />
									</>
								)}
							</div>
							{r.delta && <span className={`gui-fx-delta gui-fx-delta--${r.delta.cls}`}>{r.delta.text}</span>}
						</div>
					</div>
				))}
			</section>
			<div className="gui-fx-foot">
				<div className="gui-fx-status">
					<span className={`gui-fx-dot${dotCls}`} />
					<span>{status}</span>
				</div>
				<span className="gui-fx-signoff">FX · OPEN.ER-API.COM</span>
			</div>
		</div>
	);
}
