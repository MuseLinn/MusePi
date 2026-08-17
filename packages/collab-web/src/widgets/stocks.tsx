import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { CharTexture } from "./texture";
import { CountUp } from "./count-up";

/**
 * A-share watchlist — ported from the kimiwork "A股盯盘" widget
 * (widget_692fce1c/workspace/index.html). Real quotes via the Tencent
 * Finance JSONP endpoint (ifzq.gtimg.cn): 30-day qfq kline closes for the
 * sparkline + live price/change/percent/volume. Rows: name + code badge,
 * sparkline, ¥ price, ▲/▼ percent.
 */
export interface StockRow {
	code: string;
	label: string;
	badge: string;
	name: string;
}

export function stocksDefaults(): Record<string, unknown> {
	return {
		chip: "A-SHARES",
		title: "A股盯盘",
		rows: [
			{ code: "sh600519", label: "600519", badge: "沪", name: "贵州茅台" },
			{ code: "sz300750", label: "300750", badge: "深", name: "宁德时代" },
			{ code: "sz002594", label: "002594", badge: "深", name: "比亚迪" },
		],
	};
}

function fmt(n: number, d = 2): string {
	return Number(n).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function sparkSvg(closes: number[]): string {
	if (!Array.isArray(closes) || closes.length < 3) {
		return '<span class="gui-stocks-spark gui-stocks-spark--empty">最新报价</span>';
	}
	let lo = Infinity;
	let hi = -Infinity;
	closes.forEach(c => {
		lo = Math.min(lo, c);
		hi = Math.max(hi, c);
	});
	const span = hi - lo || 1;
	const pts = closes.map((c, i) => {
		const x = (i / Math.max(1, closes.length - 1)) * 100;
		const y = 3 + (1 - (c - lo) / span) * 22;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	return (
		'<div class="gui-stocks-spark" aria-hidden="true"><svg viewBox="0 0 100 28" preserveAspectRatio="none">' +
		`<polygon class="gui-stocks-spark-fill" points="0,28 ${pts.join(" ")} 100,28" />` +
		`<polyline fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts.join(" ")}" />` +
		"</svg></div>"
	);
}

interface Quote {
	name: string;
	label: string;
	badge: string;
	price: number;
	change: number;
	pct: number;
	volume: number;
	time: string;
	series: number[];
}

export function StocksCard({
	data,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const rawRows = Array.isArray(data.rows) ? (data.rows as StockRow[]) : [];
	const rows = rawRows.length > 0 ? rawRows : (stocksDefaults().rows as StockRow[]);
	const chip = typeof data.chip === "string" && data.chip !== "" ? data.chip : "A-SHARES";
	const title = typeof data.title === "string" && data.title !== "" ? data.title : "A股盯盘";

	const rowsElRef = useRef<HTMLDivElement | null>(null);
	const [status, setStatus] = useState("实时 A 股行情 · 每个交易日自动刷新");
	const [dotCls, setDotCls] = useState(" gui-stocks-dot--loading");
	const [quotes, setQuotes] = useState<Quote[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const loadScript = (url: string): Promise<void> =>
			new Promise((resolve, reject) => {
				const script = document.createElement("script");
				script.src = url;
				script.async = true;
				script.onload = () => resolve();
				script.onerror = () => reject(new Error("script load failed"));
				document.head.appendChild(script);
			});

		const parseKline = (row: StockRow, payload: unknown): Quote => {
			const data = (payload as { data?: Record<string, { qt?: Record<string, number[]>; qfqday?: number[][]; day?: number[][] }> })?.data;
			const d = data && data[row.code];
			if (!d) throw new Error(`${row.code} missing`);
			const qt = (d.qt && d.qt[row.code]) || [];
			const series = (d.qfqday || d.day || []).map(item => Number(item[2])).filter(Number.isFinite);
			const price = Number(qt[3]);
			const change = Number(qt[31]);
			const pct = Number(qt[32]);
			if (!Number.isFinite(price) || !Number.isFinite(change) || !Number.isFinite(pct)) {
				throw new Error(`${row.code} invalid quote`);
			}
			return {
				name: row.name,
				label: row.label,
				badge: row.badge,
				price,
				change,
				pct,
				volume: Number(qt[36] || qt[6] || 0),
				time: String(qt[30] || (d.qfqday || d.day || []).at(-1)?.[0] || ""),
				series,
			};
		};

		const rowDefs = rows;
		Promise.all(
			rowDefs.map(row => {
				const varName = `kline_${row.code}`;
				const url =
					"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=" +
					varName +
					"&param=" +
					encodeURIComponent(`${row.code},day,,,30,qfq`) +
					`&r=${Date.now()}`;
				return loadScript(url).then(() => {
					const payload = (window as unknown as Record<string, unknown>)[varName];
					return parseKline(row, payload);
				});
			}),
		)
			.then(qs => {
				if (cancelled) return;
				setQuotes(qs);
				setLoadError(null);
				setStatus(`实时 A 股行情 · 每个交易日自动刷新 · ${new Date().toLocaleTimeString("zh-CN")}`);
				setDotCls("");
			})
			.catch(error => {
				if (cancelled) return;
				setQuotes(null);
				setLoadError((error as Error).message);
				setStatus(`实时 A 股行情 · ${(error as Error).message}`);
				setDotCls(" gui-stocks-dot--err");
			});

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="gui-stocks">
			<CharTexture className="gui-stocks-tex" seed={11} />
			<header className="gui-stocks-head">
				<span className="gui-stocks-chip">{chip}</span>
				<span className="gui-stocks-title">{title}</span>
			</header>
			<section className="gui-stocks-rows" ref={rowsElRef}>
				{loadError ? (
					<div className="gui-stocks-row">
						<div className="gui-stocks-ident">
							<div className="gui-stocks-copy">
								<span className="gui-stocks-name">{title}</span>
								<span className="gui-stocks-code">LIVE</span>
							</div>
						</div>
						<div className="gui-stocks-pricebox">
							<div className="gui-stocks-price">--</div>
							<span className="gui-stocks-delta">真实 A 股行情暂时不可用</span>
						</div>
					</div>
				) : (quotes ?? []).map(q => {
					const dir = q.change >= 0 ? "up" : "down";
					const sign = q.change >= 0 ? "+" : "";
					const hasSpark = Array.isArray(q.series) && q.series.length >= 3;
					return (
						<div key={q.label} className={`gui-stocks-row gui-stocks-row--${dir}${hasSpark ? "" : " gui-stocks-row--nospark"}`}>
							<div className="gui-stocks-ident">
								<div className="gui-stocks-copy">
									<span className="gui-stocks-name">{q.name}</span>
									<span className="gui-stocks-code">{q.label}</span>
								</div>
							</div>
							{hasSpark ? (
								<div className="gui-stocks-spark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: sparkSvg(q.series) }} />
							) : null}
							<div className="gui-stocks-pricebox">
								<div className="gui-stocks-price">
									<CountUp value={q.price} format={n => `¥${fmt(n)}`} />
								</div>
								<span className="gui-stocks-delta">{q.change >= 0 ? "▲" : "▼"} {sign}{fmt(q.pct)}%</span>
							</div>
						</div>
					);
				})}
			</section>
			<div className="gui-stocks-foot">
				<div className="gui-stocks-status">
					<span className={`gui-stocks-dot${dotCls}`} />
					<span>{status}</span>
				</div>
				<span className="gui-stocks-signoff">TENCENT FINANCE</span>
			</div>
		</div>
	);
}
