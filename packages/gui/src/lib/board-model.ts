/**
 * Board model: pure widget-board state operations for BoardPage —
 * placement, collision avoidance, persistence, seed data. Zero React;
 * the only DOM touch is `localStorage` in {@link loadBoards}.
 */
import { t } from "@musepi/desktop-web";
import { type BoardWidget, widgetDef } from "@musepi/desktop-web/src/widgets/registry";

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
		title: title ?? t((def?.nameKey ?? "widget unknown") as never),
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
): BoardWidget {
	const wgt = makeWidget(type, title, w, h);
	return { ...wgt, pos: { x, y, w, h } };
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

/** Seed boards (first run): 每日财经 + Hello World collections. */
export function seedBoards(): BoardData[] {
	// 每日财经：左侧时钟 + 市场温度竖排，右侧全高超级图表，
	// 底行热力墙 + 指数磁带并排。
	const f: BoardWidget[] = [];
	f.push(at(f, "clock", t("widget clock"), 0, 0, 356, 296));
	f.push(at(f, "kline", t("widget kline"), 368, 0, 724, 604));
	f.push(at(f, "gauge", t("widget gauge"), 0, 308, 356, 296));
	f.push(at(f, "heatwall", t("widget heatwall"), 0, 616, 540, 428));
	f.push(at(f, "indextape", t("widget indextape"), 552, 616, 540, 428));
	// Hello World：fx/盯盘并排，全宽黑胶播放器，视频 + 历史并排，
	// todo/pomodoro/clock 竖排列，底部工具行。
	const h: BoardWidget[] = [];
	h.push(at(h, "fx", t("widget fx"), 0, 0, 540, 340));
	h.push(at(h, "stocks", t("widget stocks"), 552, 0, 540, 340));
	h.push(at(h, "music", t("widget music"), 0, 352, 1092, 604));
	h.push(at(h, "video", t("widget video"), 0, 968, 632, 560));
	h.push(at(h, "history", t("widget history"), 644, 968, 436, 560));
	h.push(at(h, "todo", t("widget todo"), 0, 1540, 356, 516));
	h.push(at(h, "pomodoro", t("widget pomodoro"), 368, 1540, 356, 516));
	h.push(at(h, "clock", t("widget clock"), 736, 1540, 356, 516));
	h.push(at(h, "slider", t("widget slider"), 0, 2068, 540, 252));
	h.push(at(h, "calc", t("widget calc"), 552, 2068, 540, 252));
	h.push(at(h, "metric", t("widget metric"), 0, 2332, 356, 252));
	h.push(at(h, "ticker", t("widget ticker"), 368, 2332, 356, 252));
	h.push(at(h, "gallery", t("widget gallery"), 736, 2332, 356, 252));
	// 汇率卡带一个可运行任务（运行按钮 + 查看任务弹窗）。
	const tk = h.find(w => w.type === "ticker");
	if (tk) {
		tk.data.task = {
			enabled: true,
			name: "Onboarding · 汇率抓取",
			desc: "抓取最新汇率行情条目。",
			schedule: "hourly",
			runs: [],
		};
	}
	// 指标卡任务含一条失败记录（展示失败态）；任务须描述卡片展示的
	// 内容，禁止挂无关作业。
	const mt = h.find(w => w.type === "metric");
	if (mt) {
		mt.data.task = {
			enabled: true,
			name: "指标快照更新",
			desc: "刷新本卡展示的指标快照数据。",
			schedule: "daily",
			runs: [
				{ time: "07/22 19:17", success: true },
				{ time: "07/22 11:02", success: false },
			],
		};
	}
	// 视频卡默认封面，agent 填 url/bvid 前展示。
	const vd = h.find(w => w.type === "video");
	if (vd) {
		vd.data.title = "凡人修仙传";
		vd.data.subtitle = "BILIBILI · 年番";
	}
	return [
		{ id: "finance", title: t("board finance title"), widgets: f, builtin: true },
		{ id: "hello", title: t("board hello title"), widgets: h, builtin: true },
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
