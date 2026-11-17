/**
 * Board model: pure widget-board state operations for BoardPage —
 * placement, collision avoidance, persistence, seed data. Zero React;
 * the only DOM touch is `localStorage` in {@link loadBoards}.
 */
import { t } from "@musepi/client-core";
import { type BoardWidget, widgetDef } from "@musepi/client-core/src/widgets/registry";

export const BOARDS_KEY = "musepi-gui-board:boards";
export const ACTIVE_KEY = "musepi-gui-board:active";
/** Pixel snap — resize/drag adjustments land on multiples of 8 (fine
 *  enough for "a few pixels" while keeping cards grid-aligned). */
export const SNAP = 8;
/** Board canvas base width: 12 columns × 92px grid, minus one 12px
 *  gutter = 1092px (kimi's measured canvas: 2×540+12 or 3×356+2×12 both
 *  land exactly on 1092). Cards position on the 92px grid; the surface
 *  scales to the window. */
export const BASE_W = 1092;
/** Resize steps: width 92px per column, height 44px per row (kimi's
 *  measured steps: 1092→540 wide, 472→76 tall), with a 12px gutter. */
export const SNAP_W = 92;
export const SNAP_H = 44;
export const GAP = 12;
/** kimi size bounds: min 2 cols × 2 rows (172×76 = 2×92−12 / 2×44−12),
 *  max full canvas 12 cols × 33 rows (1092×1440). */
export const MIN_W = 2 * SNAP_W - GAP;
export const MIN_H = 2 * SNAP_H - GAP;
export const MAX_H = 33 * SNAP_H - GAP;
/** Default card size for new widgets. */
export const DEF_W = 340;
export const DEF_H = 200;

export interface BoardData {
	id: string;
	title: string;
	widgets: BoardWidget[];
	/** Seed examples: protected (agents can't save, GUI can't delete). */
	builtin?: boolean;
}

export interface Ghost {
	id: string;
	rect: { x: number; y: number; w: number; h: number };
}

let boardSeq = 0;
export function nextId(prefix: string): string {
	boardSeq += 1;
	return `${prefix}${Date.now().toString(36)}-${boardSeq}`;
}

export function makeWidget(type: string, title?: string, w = DEF_W, h = DEF_H): BoardWidget {
	const def = widgetDef(type);
	return {
		id: nextId("w"),
		type,
		title: title ?? def?.label ?? t((def?.nameKey ?? "widget unknown") as never),
		data: def ? def.defaults() : {},
		pos: { x: 0, y: 0, w, h },
	};
}

/** Place a widget below the tallest card (left-aligned), with a
 *  left-to-right scan that reuses horizontal gaps when possible. */
export function placeWidget(
	widgets: BoardWidget[],
	w: number,
	h: number,
): { x: number; y: number; w: number; h: number } {
	if (widgets.length === 0) return { x: 0, y: 0, w, h };
	const maxY = Math.max(...widgets.map(wg => wg.pos.y + wg.pos.h));
	const maxX = Math.max(...widgets.map(wg => wg.pos.x + wg.pos.w));
	// First pass: scan rows (in 8px steps) for a free horizontal span at
	// the left edge; fall back to the bottom. The scan NEVER places a card
	// beyond the canvas width (BASE_W) — cards must stay on-canvas.
	const xLimit = Math.min(maxX, BASE_W - w);
	for (let y = 0; y <= maxY; y += SNAP) {
		for (let x = 0; x <= xLimit; x += SNAP) {
			let free = true;
			for (const wg of widgets) {
				if (x < wg.pos.x + wg.pos.w && x + w > wg.pos.x && y < wg.pos.y + wg.pos.h && y + h > wg.pos.y) {
					free = false;
					break;
				}
			}
			if (free) return { x, y, w, h };
		}
	}
	return { x: 0, y: maxY + GAP, w, h };
}

export function makeAndPlace(widgets: BoardWidget[], type: string, title?: string, w = DEF_W, h = DEF_H): BoardWidget {
	const wgt = makeWidget(type, title, w, h);
	return { ...wgt, pos: placeWidget(widgets, w, h) };
}

/** Seed placement: exact row/column on the BASE_W canvas so the example
 *  boards tile the full width (placeWidget is for dynamic adds). */
function at(
	_widgets: BoardWidget[],
	type: string,
	title: string,
	x: number,
	y: number,
	w: number,
	h: number,
	data: Record<string, unknown> = {},
): BoardWidget {
	const wgt = makeWidget(type, title, w, h);
	return { ...wgt, data: { ...wgt.data, ...data }, pos: { x, y, w, h } };
}

/** Derive a ticker card data patch from a normalized widget.data FX rate
 *  (open.er-api quotes 1 CNY = X EUR; the card displays CNY per EUR). */
export function tickerFxPatch(data: Record<string, unknown>, cnyPerEur: number): Record<string, unknown> {
	const old = typeof data.value === "string" ? Number(data.value) : NaN;
	const base = Number.isFinite(old) && old > 0 ? old : 7.7945;
	// Small jitter keeps the quote visibly moving (kimi ticker parity); the
	// underlying rate barely drifts over a 60s refresh window.
	const value = cnyPerEur + (Math.random() * 0.004 - 0.002);
	const delta = value - base;
	const step = Math.max(0.004, Math.abs(delta) * 2);
	const spark: number[] = [];
	let v = value - delta * 2;
	for (let i = 0; i < 7; i++) {
		v += (Math.random() - 0.5) * step;
		spark.push(Number(v.toFixed(4)));
	}
	spark.push(Number(value.toFixed(4)));
	return { value: value.toFixed(4), delta: Number(delta.toFixed(4)), spark };
}

/**
 * One card page's shell. Cards are `html` widgets now: the static card types
 * (clock / fx / stocks / kline …) were retired with the visual migration, and
 * a seed that kept referencing them rendered as an empty card — the sample
 * boards opened to a blank canvas while still reporting “8 个组件”. These
 * pages use the app's theme tokens so they follow light/dark like every other
 * page card.
 */
function seedPage(body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{height:100%;overflow:hidden;margin:0;background:transparent;color:var(--fg);font:13px/1.5 var(--font-sans,system-ui,sans-serif)}
.wrap{height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px 16px}
h3{margin:0;font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-muted)}
.big{font-size:34px;font-weight:650;letter-spacing:-.02em;line-height:1.1}
.muted{color:var(--fg-muted);font-size:12px}
.row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.up{color:var(--color-success,#2f9e63)} .down{color:var(--color-danger,#d24b45)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
td{padding:5px 0;border-top:1px solid var(--border);vertical-align:baseline}
td:nth-child(3){padding-left:16px}
td:last-child{padding-right:2px}
.num{font-family:var(--font-mono,ui-monospace,monospace);text-align:right;font-variant-numeric:tabular-nums}
.bar{height:8px;border-radius:99px;background:var(--bg-inset,rgba(0,0,0,.06));overflow:hidden}
.bar i{display:block;height:100%;border-radius:inherit;background:var(--accent)}
.heat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.heat span{display:flex;flex-direction:column;gap:2px;padding:9px 8px;border-radius:8px;font-size:11.5px}
.spark{width:100%;height:54px;display:block;flex:none}
.spark--grow{flex:1;height:auto;min-height:120px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{padding:2px 8px;border-radius:99px;border:1px solid var(--border);color:var(--fg-muted);font-size:11.5px}
.check{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;font-size:13px}
.check li{display:flex;gap:8px;align-items:flex-start}
.check b{font-weight:400;flex:1}
.done{color:var(--fg-muted);text-decoration:line-through}
.poster{position:relative;flex:1;border-radius:12px;background:linear-gradient(160deg,#1b2440,#3d2b52 55%,#7a4a3d);display:flex;align-items:flex-end;padding:18px}
.play{position:absolute;inset:0;margin:auto;width:56px;height:56px;border-radius:99px;border:1.5px solid rgba(255,255,255,.7);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px}
.tracks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.tracks li{display:flex;align-items:center;gap:10px}
.cover{width:34px;height:34px;border-radius:8px;flex:none}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function seedCard(board: BoardWidget[], title: string, x: number, y: number, w: number, h: number, body: string): void {
	board.push(at(board, "html", title, x, y, w, h, { html: seedPage(body) }));
}

/** Seed boards (first run): 每日财经 + 工作台. Each card is a real page with
 *  readable content — the examples are meant to be used, not clicked through
 *  and deleted. */
export function seedBoards(): BoardData[] {
	const f: BoardWidget[] = [];
	seedCard(
		f,
		"市场时钟",
		0,
		0,
		356,
		296,
		`<h3>市场时钟</h3><div class="big">14:32</div>
		<div class="muted">上海 · 交易中 · 周三</div>
		<table>
			<tr><td>东京</td><td class="num">15:32 收盘</td></tr>
			<tr><td>伦敦</td><td class="num">07:32 盘中</td></tr>
			<tr><td>纽约</td><td class="num">02:32 未开</td></tr>
		</table>`,
	);
	seedCard(
		f,
		"人民币汇率",
		368,
		0,
		356,
		296,
		`<h3>FX · CNY</h3><div class="big">7.0921</div>
		<div class="muted">美元 / 人民币 · <span class="down">−0.12%</span></div>
		<table>
			<tr><td>1 欧元</td><td class="num">7.7430 <span class="up">+0.08%</span></td></tr>
			<tr><td>100 日元</td><td class="num">4.7120 <span class="down">−0.05%</span></td></tr>
			<tr><td>1 英镑</td><td class="num">9.0412 <span class="up">+0.21%</span></td></tr>
		</table>`,
	);
	seedCard(
		f,
		"A股盯盘",
		736,
		0,
		356,
		296,
		`<h3>A-SHARES</h3>
		<table>
			<tr><td>贵州茅台 <span class="muted">600519</span></td><td class="num">1,682.40 <span class="up">+0.85%</span></td></tr>
			<tr><td>宁德时代 <span class="muted">300750</span></td><td class="num">254.10 <span class="up">+2.14%</span></td></tr>
			<tr><td>比亚迪 <span class="muted">002594</span></td><td class="num">268.66 <span class="up">+0.66%</span></td></tr>
			<tr><td>中芯国际 <span class="muted">688981</span></td><td class="num">96.30 <span class="up">+3.50%</span></td></tr>
			<tr><td>招商银行 <span class="muted">600036</span></td><td class="num">42.18 <span class="down">−0.44%</span></td></tr>
		</table>`,
	);
	seedCard(
		f,
		"沪深300",
		0,
		308,
		724,
		604,
		`<div class="row"><h3>沪深300</h3><span class="muted">09:30 — 15:00</span></div>
		<div class="row"><div class="big">3,940.84</div><div class="up">+1.02%</div></div>
		<svg class="spark spark--grow" viewBox="0 0 600 120" preserveAspectRatio="none">
			<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="0,96 40,88 80,92 120,74 160,80 200,62 240,68 280,52 320,58 360,44 400,50 440,38 480,46 520,34 560,40 600,30"/>
			<polygon fill="var(--accent)" opacity="0.12" points="0,96 40,88 80,92 120,74 160,80 200,62 240,68 280,52 320,58 360,44 400,50 440,38 480,46 520,34 560,40 600,30 600,120 0,120"/>
		</svg>
		<table>
			<tr><td>今开</td><td class="num">3,902.10</td><td>最高</td><td class="num">3,964.20</td></tr>
			<tr><td>昨收</td><td class="num">3,901.06</td><td>最低</td><td class="num">3,886.44</td></tr>
			<tr><td>成交额</td><td class="num">4,182 亿</td><td>换手</td><td class="num">1.24%</td></tr>
		</table>
		<div class="chips"><span class="chip">沪深300</span><span class="chip">上证指数</span><span class="chip">创业板指</span></div>`,
	);
	seedCard(
		f,
		"市场温度",
		736,
		308,
		356,
		296,
		`<h3>A股市场温度</h3><div class="big">68</div>
		<div class="bar"><i style="width:68%"></i></div>
		<div class="row"><span class="muted">偏暖 · 沪强深弱</span><span class="up">+6</span></div>
		<div class="chips"><span class="chip">上涨 3,214</span><span class="chip">下跌 1,682</span><span class="chip">涨停 62</span></div>`,
	);
	seedCard(
		f,
		"组合日收益",
		736,
		616,
		356,
		296,
		`<h3>组合日收益</h3><div class="big">+1.82%</div>
		<div class="muted">较昨日 <span class="up">+0.40%</span> · 年化 12.6%</div>
		<svg class="spark" viewBox="0 0 300 80" preserveAspectRatio="none">
			<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="0,60 30,52 60,58 90,44 120,48 150,34 180,40 210,28 240,32 270,20 300,24"/>
		</svg>`,
	);
	seedCard(
		f,
		"涨跌热力",
		0,
		924,
		540,
		428,
		`<h3>涨跌热力</h3>
		<div class="heat">
			<span style="background:color-mix(in oklab,var(--color-success,#2f9e63) 14%,transparent)">贵州茅台<b class="up">+0.85%</b></span>
			<span style="background:color-mix(in oklab,var(--color-success,#2f9e63) 34%,transparent)">宁德时代<b class="up">+2.14%</b></span>
			<span style="background:color-mix(in oklab,var(--color-success,#2f9e63) 18%,transparent)">比亚迪<b class="up">+0.66%</b></span>
			<span style="background:color-mix(in oklab,var(--color-success,#2f9e63) 46%,transparent)">中芯国际<b class="up">+3.50%</b></span>
			<span style="background:color-mix(in oklab,var(--color-danger,#d24b45) 12%,transparent)">招商银行<b class="down">−0.44%</b></span>
			<span style="background:color-mix(in oklab,var(--color-danger,#d24b45) 8%,transparent)">中国平安<b class="down">−0.22%</b></span>
			<span style="background:color-mix(in oklab,var(--color-success,#2f9e63) 30%,transparent)">紫金矿业<b class="up">+1.88%</b></span>
			<span style="background:color-mix(in oklab,var(--fg) 6%,transparent)">长江电力<b>0.00%</b></span>
		</div>
		<div class="muted">按昨日成交额加权 · 数据为示例</div>`,
	);
	seedCard(
		f,
		"指数磁带",
		552,
		924,
		540,
		428,
		`<h3>指数磁带</h3>
		<table>
			<tr><td>上证</td><td class="num">3,214.62 <span class="up">+0.88%</span></td></tr>
			<tr><td>深证</td><td class="num">10,482.10 <span class="up">+1.24%</span></td></tr>
			<tr><td>创业板</td><td class="num">2,186.44 <span class="up">+1.62%</span></td></tr>
		</table>
		<svg class="spark" viewBox="0 0 500 90" preserveAspectRatio="none">
			<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="0,70 50,64 100,68 150,52 200,56 250,44 300,50 350,38 400,42 450,30 500,34"/>
		</svg>
		<div class="chips"><span class="chip">近 5 日</span><span class="chip">成交 4,182 亿</span></div>`,
	);

	const h: BoardWidget[] = [];
	seedCard(
		h,
		"今天",
		0,
		0,
		540,
		516,
		`<h3>今天</h3>
		<ul class="check">
			<li><span>✓</span><b class="done">梳理本周发布范围</b></li>
			<li><span>✓</span><b class="done">跑通一次桌面端冒烟</b></li>
			<li><span>○</span><b>把看板示例换成真实数据</b></li>
			<li><span>○</span><b>整理插件能力缝文档</b></li>
		</ul>
		<div class="muted">2 / 4 已完成 · 下午 3 个空闲时段</div>`,
	);
	seedCard(
		h,
		"专注",
		552,
		0,
		264,
		252,
		`<h3>专注</h3><div class="big">25:00</div>
		<div class="muted">番茄钟 · 第 1 轮</div>
		<div class="chips"><span class="chip">开始</span><span class="chip">跳过</span></div>`,
	);
	seedCard(
		h,
		"市场时钟",
		828,
		0,
		264,
		252,
		`<h3>上海</h3><div class="big">14:32</div>
		<div class="muted">交易中 · 还剩 28 分钟</div>`,
	);
	seedCard(
		h,
		"劳务费个税",
		552,
		264,
		264,
		252,
		`<h3>劳务费个税</h3><div class="big">0.00</div>
		<div class="muted">收入 1,760 · 预扣 0%</div>
		<div class="row"><span class="muted">到手</span><span>1,760.00</span></div>`,
	);
	seedCard(
		h,
		"本周专注",
		828,
		264,
		264,
		252,
		`<h3>本周专注</h3><div class="big">760<span class="muted"> 分钟</span></div>
		<svg class="spark" viewBox="0 0 240 60" preserveAspectRatio="none">
			<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="0,52 40,44 80,40 120,30 160,26 200,18 240,12"/>
		</svg>
		<div class="muted">比上周 +8%</div>`,
	);
	seedCard(
		h,
		"凡人修仙传",
		0,
		528,
		540,
		560,
		`<h3>BILIBILI · 年番</h3>
		<div class="poster"><span class="play">▶</span>
			<div><div style="font-size:22px;font-weight:650;color:#fff">凡人修仙传</div>
			<div style="color:rgba(255,255,255,.72);font-size:12.5px">第 132 集 · 星海飞驰</div></div>
		</div>`,
	);
	seedCard(
		h,
		"历史上的今天",
		552,
		528,
		540,
		560,
		`<h3>HISTORY</h3><div class="big">今天</div>
		<table>
			<tr><td style="width:56px">2008</td><td>北京奥运会闭幕，中国以 51 枚金牌居金牌榜首位。</td></tr>
			<tr><td>1887</td><td>李享亭出生，中国消化病学奠基人之一。</td></tr>
			<tr><td>1980</td><td>罗杰·费德勒出生，瑞士男子职业网球运动员。</td></tr>
		</table>`,
	);
	seedCard(
		h,
		"黑胶唱片",
		0,
		1100,
		1092,
		604,
		`<h3>今日歌单</h3>
		<ul class="tracks">
			<li><span class="cover" style="background:linear-gradient(135deg,#8a5a2b,#d9a441)"></span><b style="flex:1;font-weight:400">夜航西飞</b><span class="muted">4:12</span></li>
			<li><span class="cover" style="background:linear-gradient(135deg,#2b4a8a,#5aa1d9)"></span><b style="flex:1;font-weight:400">雨落长街</b><span class="muted">3:48</span></li>
			<li><span class="cover" style="background:linear-gradient(135deg,#4a2b8a,#a15ad9)"></span><b style="flex:1;font-weight:400">纸飞机</b><span class="muted">4:05</span></li>
			<li><span class="cover" style="background:linear-gradient(135deg,#2b8a63,#5ad9a1)"></span><b style="flex:1;font-weight:400">春分</b><span class="muted">3:32</span></li>
			<li><span class="cover" style="background:linear-gradient(135deg,#8a2b45,#d95a7a)"></span><b style="flex:1;font-weight:400">远方来信</b><span class="muted">5:01</span></li>
		</ul>
		<div class="muted">示例内容 · 可在卡片菜单里替换成你的页面</div>`,
	);
	return [
		{ id: "finance", title: t("settings.boardFinanceTitle"), widgets: f, builtin: true },
		{ id: "hello", title: t("settings.boardHelloTitle"), widgets: h, builtin: true },
	];
}

/** Legacy cell layout (12-col grid, 150px rows) → pixels. Column width is
 *  estimated at 96px (a 1152px canvas) since load runs before the canvas
 *  is measured; cards keep their proportions. */
export function migrateCellPos(w: BoardWidget): BoardWidget {
	const p = w.pos as unknown as { c?: number; r?: number; w?: number; h?: number };
	if (p.c === undefined || p.r === undefined) return w;
	const colW = 96;
	return {
		...w,
		pos: {
			x: (p.c ?? 0) * colW,
			y: (p.r ?? 0) * 150,
			w: (p.w ?? 4) * colW,
			h: (p.h ?? 1) * 150,
		},
	};
}

/** Builtin examples restore their pristine seed layout on load — drag /
 *  resize / task-run changes are session-only ephemeral, the boards come
 *  back factory-fresh after a relaunch. */
export function restoreBuiltinBoards(boards: BoardData[]): BoardData[] {
	const seeds = seedBoards();
	return boards.map(b => {
		if (b.builtin !== true) return b;
		const seed = seeds.find(s => s.id === b.id);
		return seed ? { ...seed } : b;
	});
}

/** Seed boards are protected: agents may not modify them (board tool
 *  rejects) and the GUI hides delete for them (builtin flag). Legacy
 *  stored seeds are re-flagged by id. */
export function markBuiltin(b: BoardData): BoardData {
	if (b.builtin === true || b.id === "finance" || b.id === "hello") return { ...b, builtin: true };
	return b;
}

export function sanitizeBoard(b: BoardData): BoardData {
	const dirty = b.widgets.some(w => [w.pos.x, w.pos.y, w.pos.w, w.pos.h].some(v => v % 1 !== 0));
	if (!dirty) return markBuiltin(b);
	return markBuiltin({
		...b,
		widgets: b.widgets.map(w => ({
			...w,
			pos: {
				x: Math.round(w.pos.x),
				y: Math.round(w.pos.y),
				w: Math.round(w.pos.w),
				h: Math.round(w.pos.h),
			},
		})),
	});
}

/** Builtin examples are protected (the GUI hides their delete), so their
 *  absence in a non-empty store means an external full-list overwrite
 *  dropped them — re-inject the seeds. An EMPTY store is respected
 *  (user deleted everything). */
export function ensureBuiltinSeeds(boards: BoardData[]): BoardData[] {
	if (boards.length === 0) return boards;
	const seeds = seedBoards();
	const have = new Set(boards.map(b => b.id));
	const missing = seeds.filter(s => !have.has(s.id));
	return missing.length > 0 ? [...boards, ...missing] : boards;
}

/** External-board merge for periodic refresh (TUI/GUI distribution):
 *  the local view is authoritative for boards the user is looking at, but
 *  boards the agent created on the daemon (ids unknown locally) must not
 *  be clobbered by a stale local snapshot — append them. Deletion stays
 *  local: a removed board is absent here and the daemon save has already
 *  flushed it, so it never comes back; builtin seeds are re-injected by
 *  {@link ensureBuiltinSeeds}. */
export function mergeDaemonBoards(local: BoardData[], daemon: BoardData[]): BoardData[] {
	const localIds = new Set(local.map(b => b.id));
	const fresh = daemon.filter(b => !localIds.has(b.id) && b.builtin !== true);
	if (fresh.length === 0) return local;
	return [...local, ...fresh.map(markBuiltin)];
}

export function loadBoards(): BoardData[] {
	try {
		const raw = localStorage.getItem(BOARDS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as BoardData[];
			if (Array.isArray(parsed)) {
				// An empty array is LEGAL (the user deleted every board) —
				// only a missing key reseeds the examples.
				if (parsed.length === 0) return [];
				let migrated = false;
				const next = parsed.map(b => {
					if (b.widgets.some(w => (w.pos as { c?: number }).c !== undefined)) {
						migrated = true;
						return { ...b, widgets: b.widgets.map(migrateCellPos) };
					}
					// Whole-pixel guarantee: round any fractional leftovers
					// from older resize clamps.
					const san = sanitizeBoard(b);
					if (san !== b) migrated = true;
					return san;
				});
				if (migrated) {
					try {
						localStorage.setItem(BOARDS_KEY, JSON.stringify(next));
					} catch {
						// keep in-memory
					}
				}
				// Builtin boards always restore their seed layout; missing
				// seeds (external overwrite) are re-injected.
				return ensureBuiltinSeeds(restoreBuiltinBoards(next));
			}
		}
	} catch {
		// corrupt — reseed
	}
	const seeded = seedBoards();
	try {
		localStorage.setItem(BOARDS_KEY, JSON.stringify(seeded));
	} catch {
		// storage unavailable
	}
	return seeded;
}

/** True when two pixel rects overlap (with a small gutter so adjacent
 *  cards with the 14px gap never count as colliding). */
export function overlaps(
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
): boolean {
	const g = GAP - 4;
	return a.x < b.x + b.w - g && a.x + a.w - g > b.x && a.y < b.y + b.h - g && a.y + a.h - g > b.y;
}

/** Push colliding widgets down until every rect is clear — kimi-style
 *  greedy avoidance. Chain: a pushed widget becomes a collision source
 *  itself (it may land on its neighbors), so pushes cascade instead of
 *  leaving the pushed card overlapping its siblings. Mutates a copy. */
export function resolveCollisions(widgets: BoardWidget[], moved: BoardWidget, excludeId: string): BoardWidget[] {
	const next = widgets.map(w => ({ ...w, pos: { ...w.pos } }));
	const seen = new Set<string>([excludeId]);
	const stack: { id: string; pos: BoardWidget["pos"] }[] = [{ id: excludeId, pos: moved.pos }];
	let guard = 0;
	while (stack.length > 0 && guard++ < 400) {
		const cur = stack.shift();
		if (!cur) break;
		for (const w of next) {
			if (w.id === excludeId || w.id === cur.id || seen.has(w.id)) continue;
			if (overlaps(w.pos, cur.pos)) {
				const ny = cur.pos.y + cur.pos.h + GAP;
				w.pos = { ...w.pos, y: ny };
				seen.add(w.id);
				stack.push({ id: w.id, pos: w.pos });
			}
		}
	}
	return next;
}

/** Snap a dimension to the fine pixel grid. */
export function snap(v: number): number {
	return Math.round(v / SNAP) * SNAP;
}
