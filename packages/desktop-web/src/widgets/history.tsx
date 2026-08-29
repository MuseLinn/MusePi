import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useThemePreference } from "../lib/theme";
import { widgetFetch } from "./fetch";

/**
 * "On this day in history" — ported from the kimiwork "历史上的今天" widget
 * (widget_04abd2b6/workspace/index.html). Real data: 60s.viki.moe
 * today-in-history (Baidu Baike), with a domestic fallback line, then the
 * seed events as offline fallback. Canvas-pixel HISTORY logo (5×3 bitmap
 * font), grid layout that adapts to the card aspect, "+()" character
 * texture background, blue pulsing date block, 12 shuffled events sorted
 * by year desc, and a 换一批 reload.
 */
export interface HistoryEvent {
	year: string;
	text: string;
	link?: string;
}

const FONT: Record<string, string[]> = {
	H: ["101", "101", "111", "101", "101"],
	I: ["111", "010", "010", "010", "111"],
	S: ["111", "100", "111", "001", "111"],
	T: ["111", "010", "010", "010", "010"],
	O: ["111", "101", "101", "101", "111"],
	R: ["111", "101", "110", "101", "101"],
	Y: ["101", "101", "010", "010", "010"],
};

export function historyDefaults(): Record<string, unknown> {
	return {
		header: "HISTORY",
		date: "历史上的今天",
		events: [
			{
				year: "2008",
				text: "北京承办的奥运会为世界奉献了一场精彩的体育盛宴，共创造43项新世界纪录及132项新奥运纪录，中国以51枚金牌居金牌榜首位。",
			},
			{ year: "1887", text: "李享亭（1897～1987），内科专家、医学教育家、中国消化病学的奠基人。" },
			{ year: "1980", text: "罗杰·费德勒（Roger Federer, 1981年8月8日—），瑞士男子职业网球运动员。" },
		],
	};
}

function esc(s: string): string {
	const d = document.createElement("div");
	d.textContent = s;
	return d.innerHTML;
}

/** Resolve a CSS variable for canvas drawing — getContext("2d") needs a
 *  concrete color string, so read the themed token from computed style. */
function readVar(el: HTMLElement, name: string, fallback: string): string {
	const v = getComputedStyle(el).getPropertyValue(name).trim();
	return v || fallback;
}

export function HistoryCard({
	data,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const header = typeof data.header === "string" && data.header !== "" ? data.header : "HISTORY";
	const seedEvents = (Array.isArray(data.events) ? (data.events as HistoryEvent[]) : []) as HistoryEvent[];
	const seed = seedEvents.length > 0 ? seedEvents : (historyDefaults().events as HistoryEvent[]);

	const logoRef = useRef<HTMLCanvasElement | null>(null);
	const texRef = useRef<HTMLCanvasElement | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const headRef = useRef<HTMLHeadingElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const footRef = useRef<HTMLDivElement | null>(null);
	const dateRef = useRef<HTMLSpanElement | null>(null);

	const [all, setAll] = useState<HistoryEvent[]>(seed);
	const [source, setSource] = useState("数据来源 · 正在连接可用线路…");
	const [rows, setRows] = useState<HistoryEvent[]>([]);
	const [loading, setLoading] = useState(false);
	const [offline, setOffline] = useState(false);
	const { resolved } = useThemePreference();

	// ── pixel HISTORY logo (5×3 bitmap per letter) ─────────────────────
	useEffect(() => {
		const c = logoRef.current;
		if (!c) return;
		const word = header.toUpperCase().replace(/[^HISTORY]/g, "");
		const px = 4;
		const gap = 1;
		const sp = 2;
		const cols = word.length * (3 + sp) - sp;
		c.width = cols * (px + gap);
		c.height = 5 * (px + gap);
		const g = c.getContext("2d");
		if (!g) return;
		g.fillStyle = readVar(c, "--color-text", "#FFFFFF");
		let x0 = 0;
		for (const ch of word) {
			const glyph = FONT[ch];
			if (!glyph) continue;
			glyph.forEach((r, y) => {
				r.split("").forEach((b, x) => {
					if (b === "1") g.fillRect((x0 + x) * (px + gap), y * (px + gap), px, px);
				});
			});
			x0 += 3 + sp;
		}
	}, [header, resolved]);

	// ── "+()" character texture (mulberry32 seeded, keep-out zones) ────
	useEffect(() => {
		const cv = texRef.current;
		const stage = stageRef.current;
		if (!cv || !stage) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const W = stage.clientWidth;
		const H = stage.clientHeight;
		if (W <= 0 || H <= 0) return;
		cv.width = Math.max(1, Math.round(W * dpr));
		cv.height = Math.max(1, Math.round(H * dpr));
		const ctx = cv.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		const CELL = 15;
		const cols = Math.ceil(W / CELL) + 1;
		const rowsCount = Math.ceil(H / CELL) + 1;
		let a = 20260714;
		const rng = () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const keepOut = [headRef.current, panelRef.current, footRef.current]
			.filter((el): el is NonNullable<typeof headRef.current> => !!el)
			.map(el => {
				const r = el.getBoundingClientRect();
				const s = stage.getBoundingClientRect();
				return { x: r.left - s.left - 6, y: r.top - s.top - 6, w: r.width + 12, h: r.height + 12 };
			});
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.font = '12px Menlo, "SF Mono", "DejaVu Sans Mono", monospace';
		const TEX_CH = "+()";
		for (let r = 0; r < rowsCount; r++) {
			for (let c = 0; c < cols; c++) {
				const x = c * CELL + CELL / 2;
				const y = r * CELL + CELL / 2;
				let fade = 1;
				for (const k of keepOut) {
					const dx = Math.max(k.x - x, 0, x - (k.x + k.w));
					const dy = Math.max(k.y - y, 0, y - (k.y + k.h));
					if (dx === 0 && dy === 0) {
						fade = -1;
						break;
					}
					const d = Math.sqrt(dx * dx + dy * dy);
					if (d < CELL && d / CELL < fade) fade = d / CELL;
				}
				if (fade < 0) continue;
				if (rng() >= 0.7) continue;
				const q = rng();
				const ch = q < 0.6 ? TEX_CH[0] : q < 0.8 ? TEX_CH[1] : TEX_CH[2];
				ctx.globalAlpha = 0.75 * fade;
				ctx.fillStyle = readVar(cv, "--color-text-faint", "#002E58");
				ctx.fillText(ch, x, y);
			}
		}
		ctx.globalAlpha = 1;
	}, [resolved]);

	// ── data load: 60s API → yum6 fallback → seed offline ──────────────
	const loadRef = useRef(0);
	useEffect(() => {
		const gen = ++loadRef.current;
		setLoading(true);
		setOffline(false);
		setSource("数据来源 · 正在连接可用线路…");
		const sources: Array<{ label: string; url: string; parse: (p: unknown) => HistoryEvent[] }> = [
			{
				label: "60s API · 百度百科 · 实时获取",
				url: "https://60s.viki.moe/v2/today-in-history",
				parse: payload => {
					const items = (
						payload as { data?: { items?: Array<{ year?: string; description?: string; title?: string }> } }
					)?.data?.items;
					if (!Array.isArray(items)) return [];
					return items.map(ev => ({
						year: String(ev?.year ?? ""),
						text: ev?.description || ev?.title || "",
						link: "",
					}));
				},
			},
			{
				label: "百度百科 · 国内备用线路 · 实时获取",
				url: "https://api.yum6.cn/briefing/baidu.php?format=json",
				parse: payload => {
					const items = (payload as { content?: string[] })?.content;
					if (!Array.isArray(items)) return [];
					return items.map(title => ({ year: "今日", text: String(title ?? ""), link: "" }));
				},
			},
		];
		const trySource = (index: number): Promise<{ rows: HistoryEvent[]; label: string }> => {
			if (index >= sources.length) return Promise.reject(new Error("all sources unavailable"));
			const s = sources[index];
			return widgetFetch(s.url, { cache: "no-store", credentials: "omit" })
				.then(res => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.json();
				})
				.then(payload => {
					const list = s.parse(payload).filter(ev => ev?.text);
					if (!list.length) throw new Error("empty events");
					return { rows: list, label: s.label };
				})
				.catch(() => trySource(index + 1));
		};
		trySource(0)
			.then(result => {
				if (gen !== loadRef.current) return;
				setAll(result.rows);
				setSource(`数据来源 · ${result.label}`);
				setRows(pick(result.rows, 12));
			})
			.catch(() => {
				if (gen !== loadRef.current) return;
				setOffline(true);
				setSource("数据来源 · 当前线路不可用（离线示例）");
				setAll(seed);
				setRows(pick(seed, Math.min(seed.length, 12)));
			})
			.finally(() => {
				if (gen === loadRef.current) setLoading(false);
			});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const pick = (pool: HistoryEvent[], n: number): HistoryEvent[] => {
		const copy = pool.slice();
		for (let i = copy.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[copy[i], copy[j]] = [copy[j], copy[i]];
		}
		return copy.slice(0, n).sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0));
	};

	const shuffle = () => {
		if (all.length) setRows(pick(all, 12));
		else setRows(pick(seed, Math.min(seed.length, 12)));
	};
	const reload = () => {
		if (all.length) {
			setRows(pick(all, 12));
		} else {
			// 离线时重新尝试拉取
			loadRef.current++;
			setLoading(true);
			widgetFetch("https://60s.viki.moe/v2/today-in-history", { cache: "no-store" })
				.then(r => r.json())
				.then(p => {
					const items = (
						p as { data?: { items?: Array<{ year?: string; description?: string; title?: string }> } }
					)?.data?.items;
					if (Array.isArray(items) && items.length) {
						const list = items
							.map(ev => ({ year: String(ev?.year ?? ""), text: ev?.description || ev?.title || "", link: "" }))
							.filter(ev => ev.text);
						setAll(list);
						setSource("数据来源 · 60s API · 百度百科 · 实时获取");
						setRows(pick(list, 12));
					}
				})
				.catch(() => {})
				.finally(() => setLoading(false));
		}
	};

	const now = new Date();
	const dateLabel = `${now.getMonth() + 1}.${now.getDate()}`;
	const shown = rows.length > 0 ? rows : [];

	return (
		<div className="gui-widget-history" ref={stageRef}>
			<canvas ref={texRef} className="gui-widget-history-tex" aria-hidden="true" />
			<h1 className="gui-widget-history-head" ref={headRef}>
				<canvas ref={logoRef} className="gui-widget-history-logo" aria-hidden="true" />
				<span className="gui-widget-history-headline">
					<span className="gui-widget-history-date" ref={dateRef}>
						{dateLabel}
					</span>
					<span className="gui-widget-history-sub">
						{header === "HISTORY" ? "历史上的今天" : String(data.date ?? "历史上的今天")}
					</span>
				</span>
			</h1>
			<div className="gui-widget-history-panel" ref={panelRef}>
				{loading && shown.length === 0 ? (
					<div className="gui-widget-history-state">正在从可用线路获取今日事件…</div>
				) : shown.length === 0 ? (
					<div className="gui-widget-history-state">
						{offline ? "历史事件获取失败，请稍后重试" : "暂时没有可显示的历史事件"}
					</div>
				) : (
					shown.map((ev, i) => (
						<div className="gui-widget-history-ev" key={`${ev.year}-${i}`}>
							<span className="gui-widget-history-yr">{ev.year || "—"}</span>
							<span className="gui-widget-history-copy">
								{esc(ev.text)}
								{ev.link && (
									<a href={ev.link} target="_blank" rel="noopener noreferrer">
										→
									</a>
								)}
							</span>
						</div>
					))
				)}
			</div>
			<div className="gui-widget-history-foot" ref={footRef}>
				<span className="gui-widget-history-src">{source}</span>
				<button type="button" className="gui-widget-history-go" onClick={reload} disabled={loading}>
					{loading ? "加载中…" : "换一批"}
				</button>
			</div>
		</div>
	);
}
