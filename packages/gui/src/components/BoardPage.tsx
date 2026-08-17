import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";
import { WidgetErrorBoundary } from "@musepi/collab-web/src/widgets/error-boundary";
import { WidgetFit } from "@musepi/collab-web/src/widgets/fit";
import { hasTask, type WidgetTask } from "@musepi/collab-web/src/widgets/task";
import { ContextMenu } from "./ContextMenu";
import { DialogFrame } from "./DialogFrame";
import { SpotlightCard } from "./SpotlightCard";
import { tapFeedback } from "../lib/haptic";
import { WidgetEditor } from "./WidgetEditor";
import { TaskModal, widgetHasTask } from "./TaskModal";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { WIDGET_REGISTRY, widgetDef, type BoardWidget } from "@musepi/collab-web/src/widgets/registry";

/**
 * BoardPage — kimi-work-style widget boards (docs/board-dashboard.md).
 * Two levels: board HOME (collection list) + collection canvas. Cards are
 * absolutely positioned in PIXELS on a free canvas, snapped to an 8px grid
 * (kimi pixel-precise resize: 356×252 readouts, a few px of adjustment).
 * Drag (top bar), resize (corner handle, live pixel readout), collision
 * push, predictive ghost, hover menu (放大 / 删除), SpotlightCard glow,
 * and localStorage persistence. Legacy cell-layout data migrates on load.
 */

const BOARDS_KEY = "omp-gui-board:boards";
const ACTIVE_KEY = "omp-gui-board:active";
/** Pixel snap — resize/drag adjustments land on multiples of 8 (fine
 *  enough for "a few pixels" while keeping cards grid-aligned). */
const SNAP = 8;
/** Board canvas base width: 12 columns × 92px grid, minus one 12px
 *  gutter = 1092px (kimi's measured canvas: 2×540+12 or 3×356+2×12 both
 *  land exactly on 1092). Cards position on the 92px grid; the surface
 *  scales to the window. */
const BASE_W = 1092;
/** Resize steps: width 92px per column, height 44px per row (kimi's
 *  measured steps: 1092→540 wide, 472→76 tall), with a 12px gutter. */
const SNAP_W = 92;
const SNAP_H = 44;
const GAP = 12;
/** kimi size bounds: min 2 cols × 2 rows (172×76 = 2×92−12 / 2×44−12),
 *  max full canvas 12 cols × 33 rows (1092×1440). */
const MIN_W = 2 * SNAP_W - GAP;
const MIN_H = 2 * SNAP_H - GAP;
const MAX_H = 33 * SNAP_H - GAP;
/** Default card size for new widgets. */
const DEF_W = 340;
const DEF_H = 200;

interface BoardData {
	id: string;
	title: string;
	widgets: BoardWidget[];
	/** Seed examples: protected (agents can't save, GUI can't delete). */
	builtin?: boolean;
}

interface Ghost {
	id: string;
	rect: { x: number; y: number; w: number; h: number };
}

let boardSeq = 0;
function nextId(prefix: string): string {
	boardSeq += 1;
	return `${prefix}${Date.now().toString(36)}-${boardSeq}`;
}

function makeWidget(type: string, title?: string, w = DEF_W, h = DEF_H): BoardWidget {
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
function placeWidget(widgets: BoardWidget[], w: number, h: number): { x: number; y: number; w: number; h: number } {
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
				if (
					x < wg.pos.x + wg.pos.w &&
					x + w > wg.pos.x &&
					y < wg.pos.y + wg.pos.h &&
					y + h > wg.pos.y
				) {
					free = false;
					break;
				}
			}
			if (free) return { x, y, w, h };
		}
	}
	return { x: 0, y: maxY + GAP, w, h };
}

function makeAndPlace(widgets: BoardWidget[], type: string, title?: string, w = DEF_W, h = DEF_H): BoardWidget {
	const wgt = makeWidget(type, title, w, h);
	return { ...wgt, pos: placeWidget(widgets, w, h) };
}

/** Seed placement: exact row/column on the BASE_W canvas so the example
 *  boards tile the full width (placeWidget is for dynamic adds). */
function at(widgets: BoardWidget[], type: string, title: string, x: number, y: number, w: number, h: number): BoardWidget {
	const wgt = makeWidget(type, title, w, h);
	return { ...wgt, pos: { x, y, w, h } };
}

/** Seed boards (first run): 每日财经 + Hello World collections. */
function seedBoards(): BoardData[] {
	// 每日财经 — kimi layout: 12-col × 92px grid (1104 canvas). Left
	// column 4 cols (clock + gauge stacked), K-STATION 8 cols full-height
	// right, heatwall + indextape 6 cols each on the bottom row.
	// kimi REAL finance placements (92px cols × 44px rows, 12px gutter):
	// MARKET PULSE (4×7) + K-STATION (8×14) top row, market sentiment
	// (4×7) below the clock, heat wall + index tape (6×10) bottom row.
	const f: BoardWidget[] = [];
	f.push(at(f, "clock", "MARKET PULSE", 0, 0, 356, 296));
	f.push(at(f, "kline", "K-STATION", 368, 0, 724, 604));
	f.push(at(f, "gauge", t("widget gauge"), 0, 308, 356, 296));
	f.push(at(f, "heatwall", t("widget heatwall"), 0, 616, 540, 428));
	f.push(at(f, "indextape", t("widget indextape"), 552, 616, 540, 428));
	// kimi Hello-World parity — REAL placements from kimiwork's canvas
	// definition (92px cols × 44px rows): fx/stocks row (6×8 each),
	// full-width vinyl hero (12×14), promo video (7×13) + history (5×13),
	// todo/pomodoro/clock column (4×12 each), utility tail.
	// kimi REAL Hello-World grid (92px cols × 44px rows, 12px gutter):
	// fx/stocks 6×8, full-width vinyl hero 12×14, promo video 7×13 +
	// history 5×13, todo/pomodoro/clock 4×12 column, utility tail.
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
	h.push(at(h, "metric", "Metric", 0, 2332, 356, 252));
	h.push(at(h, "ticker", t("widget ticker"), 368, 2332, 356, 252));
	h.push(at(h, "gallery", t("widget gallery"), 736, 2332, 356, 252));
	// A runnable-task card (kimi demo: 汇率任务 — 运行 button + 查看任务
	// modal) and a video card (kimi PROMO REEL parity).
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
	// A failed-run task card shows the failure state in 近期运行 (kimi demo).
	// The task is consistent with the card's content (metric snapshot —
	// tasks must describe what the card shows, agents must not attach
	// unrelated jobs).
	const mt = h.find(w => w.type === "metric");
	if (mt) {
		mt.data.task = {
			enabled: true,
			name: "指标快照更新",
			desc: "刷新本卡展示的指标快照数据。",
			schedule: "daily",
			runs: [{ time: "07/22 19:17", success: true }, { time: "07/22 11:02", success: false }],
		};
	}
	// PROMO REEL cover: title/subtitle/duration until an agent fills url.
	const vd = h.find(w => w.type === "video");
	if (vd) {
		vd.data.title = "Kimi Work 介绍";
		vd.data.subtitle = "PROMO REEL";
		vd.data.duration = "00:05";
	}
	return [
		{ id: "finance", title: t("board finance title"), widgets: f, builtin: true },
		{ id: "hello", title: t("board hello title"), widgets: h, builtin: true },
	];
}

/** Focus-modal card size: FIXED aspect + fixed base size (kimi shows the
 *  maximized card at a set proportion and dimensions — not a proportional
 *  zoom of the card's board size), clamped only to small windows. */
function focusCardSize(): { width: number; height: number } {
	// Larger maximized card (kimi parity — the focused widget gets room to
	// breathe): 760×570 4:3, clamped to the viewport.
	const FW = 760;
	const FH = 570;
	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	const w = Math.min(FW, vw - 48, (vh - 96) * (FW / FH));
	return { width: Math.round(w), height: Math.round(w * (FH / FW)) };
}

/** Legacy cell layout (12-col grid, 150px rows) → pixels. Column width is
 *  estimated at 96px (a 1152px canvas) since load runs before the canvas
 *  is measured; cards keep their proportions. */
function migrateCellPos(w: BoardWidget): BoardWidget {
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

/** Whole-pixel guarantee: positions are exact integers (the pixel
 *  canvas renders smoothly scaled, but state is integer). */
/** Builtin examples restore their pristine seed layout on load — drag /
 *  resize / task-run changes are session-only ephemeral, the boards come
 *  back factory-fresh after a relaunch. */
function restoreBuiltinBoards(boards: BoardData[]): BoardData[] {
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
function markBuiltin(b: BoardData): BoardData {
	if (b.builtin === true || b.id === "finance" || b.id === "hello") return { ...b, builtin: true };
	return b;
}

function sanitizeBoard(b: BoardData): BoardData {
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
function ensureBuiltinSeeds(boards: BoardData[]): BoardData[] {
	if (boards.length === 0) return boards;
	const seeds = seedBoards();
	const have = new Set(boards.map(b => b.id));
	const missing = seeds.filter(s => !have.has(s.id));
	return missing.length > 0 ? [...boards, ...missing] : boards;
}

function loadBoards(): BoardData[] {
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
function overlaps(
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
function resolveCollisions(widgets: BoardWidget[], moved: BoardWidget, excludeId: string): BoardWidget[] {
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
function snap(v: number): number {
	return Math.round(v / SNAP) * SNAP;
}

/** Three-dot card menu (kimi parity): 固定至桌面 + 删除. Rendered above
 *  the card chrome; used both on the board card and in the focus modal. */
function CardMenuButton({
	onPin,
	onDelete,
	onViewTask,
	align = "right",
}: {
	onPin(): void;
	onDelete(): void;
	onViewTask?(): void;
	align?: "left" | "right";
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	return (
		<span ref={anchorRef} onPointerDown={e => e.stopPropagation()}>
			<button
				type="button"
				className="gui-board-card-act"
				aria-label={t("widget menu")}
				title={t("widget menu")}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="more-2" className="h-3.5 w-3.5" />
			</button>
			{renderMenu(
				<div className="gui-context-menu" role="menu">
					<button
						type="button"
						className="gui-menu-item"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							onPin();
						}}
					>
						<Icon name="pushpin" className="h-4 w-4" />
						<span>{t("widget pin to desktop")}</span>
					</button>
					{onViewTask && (
						<button
							type="button"
							className="gui-menu-item"
							role="menuitem"
							onClick={() => {
								setOpen(false);
								onViewTask();
							}}
						>
							<Icon name="list-check-2" className="h-4 w-4" />
							<span>{t("widget view task")}</span>
						</button>
					)}
					<button
						type="button"
						className="gui-menu-item gui-menu-item--danger"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							onDelete();
						}}
					>
						<Icon name="delete-bin" className="h-4 w-4" />
						<span>{t("widget remove")}</span>
					</button>
				</div>,
			)}
		</span>
	);
}

/** Board home: collection cards + new-collection prompt input. */
function BoardHome({
	boards,
	onOpen,
	onCreate,
	onDelete,
	onChatCreate,
}: {
	boards: BoardData[];
	onOpen(id: string): void;
	onCreate(title: string): void;
	onDelete(id: string): void;
	onChatCreate(text: string): void;
}): ReactNode {
	const [draft, setDraft] = useState("");
	// Collection-card context menu (open / delete — the examples must be
	// removable, kimi boards are user-owned).
	const [menu, setMenu] = useState<{ x: number; y: number; board: BoardData } | null>(null);
	// Delete flow: confirm dialog → card removal animation → real delete.
	const [confirmBoard, setConfirmBoard] = useState<BoardData | null>(null);
	const [removing, setRemoving] = useState<Set<string>>(new Set());
	const requestDelete = (b: BoardData): void => {
		setMenu(null);
		setConfirmBoard(b);
	};
	const doDelete = (): void => {
		if (!confirmBoard) return;
		tapFeedback(1);
		const id = confirmBoard.id;
		setConfirmBoard(null);
		setRemoving(prev => new Set(prev).add(id));
		window.setTimeout(() => {
			onDelete(id);
			setRemoving(prev => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		}, 380);
	};
	return (
		<div className="gui-board-home">
			<div className="gui-board-home-head">
				<h2 className="gui-board-home-title">{t("board")}</h2>
				<p className="gui-board-home-desc">{t("board home desc")}</p>
				<button type="button" className="gui-btn gui-board-home-chat" onClick={() => onChatCreate("")}>
					<Icon name="add" className="h-4 w-4" />
					<span>{t("board chat create")}</span>
				</button>
			</div>
			<div className="gui-board-home-grid">
				{boards.map((b, bi) => (
					<button
						key={b.id}
						type="button"
						className={`gui-board-home-card${removing.has(b.id) ? " gui-board-home-card--removing" : ""}`}
						style={{ animationDelay: `${bi * 60}ms` }}
						onClick={() => onOpen(b.id)}
						onContextMenu={e => {
							e.preventDefault();
							setMenu({ x: e.clientX, y: e.clientY, board: b });
						}}
					>
						{!b.builtin && (
							<span
								className="gui-board-home-card-x"
								role="button"
								aria-label={t("delete")}
								title={t("delete")}
								onClick={e => {
									e.stopPropagation();
									requestDelete(b);
								}}
							>
								<Icon name="close" className="h-3 w-3" />
							</span>
						)}
						{/* Live preview: 2×2 grid of the first four widgets (kimi
						 * layout — preview on top, name + count below), rendered
						 * legibly and replayed on every visit. */}
						<div className="gui-board-home-preview">
							{b.widgets.slice(0, 4).map((w, wi) => {
								const def = widgetDef(w.type);
								if (!def) return null;
								return (
									<div
										key={w.id}
										className="gui-board-home-preview-cell"
										data-tone={def.tone ?? "default"}
										style={{ animationDelay: `${bi * 60 + wi * 90}ms` }}
									>
										<def.Component data={w.data} update={() => {}} />
									</div>
								);
							})}
						</div>
						<div className="gui-board-home-card-title">{b.title}</div>
						<div className="gui-board-home-card-meta">
							{b.builtin ? (
								<span className="gui-board-home-tag">{t("board example")}</span>
							) : (
								<span className="gui-board-home-tag gui-board-home-tag--mine">{t("board mine")}</span>
							)}
							<span className="gui-board-home-count">
								{b.widgets.length} {t("widgets count")}
							</span>
						</div>
					</button>
				))}
				<button
					type="button"
					className="gui-board-home-card gui-board-home-card--new"
					onClick={() => onCreate(t("board new title"))}
				>
					<Icon name="add" className="h-5 w-5" />
					<span>{t("board new")}</span>
				</button>
			</div>
			{menu && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					open
					onClose={() => setMenu(null)}
					items={[
						{
							label: t("open"),
							icon: "folder-open",
							onSelect: () => onOpen(menu.board.id),
						},
						...(menu.board.builtin
							? [
									{
										label: t("board builtin"),
										icon: "lock",
										disabled: true,
									},
								]
							: [
									{
										label: t("delete"),
										icon: "delete-bin",
										danger: true,
										onSelect: () => requestDelete(menu.board),
									},
								]),
					]}
				/>
			)}
			{confirmBoard && (
				<DialogFrame open label={t("board remove")} onClose={() => setConfirmBoard(null)} className="gui-board-remove-dialog">
					<div className="gui-board-remove">
						<p className="gui-board-remove-desc">
							{t("board remove confirm", { name: confirmBoard.title })}
						</p>
						<p className="gui-board-remove-hint">{t("board remove hint", { count: confirmBoard.widgets.length })}</p>
						<div className="gui-cron-form-actions">
							<button type="button" className="gui-btn" onClick={() => setConfirmBoard(null)}>
								{t("cancel")}
							</button>
							<button type="button" className="gui-btn gui-scheduled-del" onClick={doDelete}>
								{t("board remove")}
							</button>
						</div>
					</div>
				</DialogFrame>
			)}
			<SpotlightCard
				className="gui-board-home-create"
				spotlightColor="color-mix(in oklab, var(--color-accent) 10%, transparent)"
				glowSize={340}
			>
				<input
					className="gui-board-home-input"
					value={draft}
					placeholder={t("board create placeholder")}
					onChange={e => setDraft(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter" && draft.trim()) {
							onChatCreate(draft.trim());
							setDraft("");
						}
					}}
				/>
				<button
					type="button"
					className="gui-board-home-send"
					disabled={!draft.trim()}
					onClick={() => {
						tapFeedback();
						onChatCreate(draft.trim());
						setDraft("");
					}}
				>
					<Icon name="arrow-up" className="h-4 w-4" />
				</button>
			</SpotlightCard>
		</div>
	);
}

export interface BoardRpc {
	request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export function BoardPage({
	onBack,
	rpc,
	jumpId,
	onJumpConsumed,
	onChatCreate,
}: {
	onBack(): void;
	rpc?: BoardRpc;
	/** daimon-canvas jump from chat: open this board once it mounts. */
	jumpId?: string | null;
	onJumpConsumed?(): void;
	/** 对话创建: leave the board and open a chat prompt to design boards. */
	onChatCreate?(text: string): void;
}): ReactNode {
	const [boards, setBoards] = useState<BoardData[]>(() => loadBoards());
	// Daemon persistence: boards live at ~/.musepi/boards/boards.json (the
	// GUI, the agent and other windows share one store). localStorage is
	// the offline/daemon-down fallback — seeds merge in when empty.
	const [boardsReady, setBoardsReady] = useState(false);
	useEffect(() => {
		if (!rpc || boardsReady) return;
		let alive = true;
		void rpc
			.request("board.list")
			.then(async res => {
				if (!alive) return;
				const list = (res as { boards?: BoardData[] } | null)?.boards;
				if (Array.isArray(list)) {
					if (list.length > 0) {
						const clean = ensureBuiltinSeeds(restoreBuiltinBoards(list.map(sanitizeBoard)));
						setBoards(clean);
						try {
							localStorage.setItem(BOARDS_KEY, JSON.stringify(clean));
						} catch {
							// ignore
						}
					} else {
						// Daemon empty: honor a deleted-all state (localStorage
						// has []) or reseed on true first run (no key).
						setBoards(loadBoards());
					}
				}
			})
			.catch(() => {
				// daemon down — keep localStorage boards
			})
			.finally(() => {
				if (alive) setBoardsReady(true);
			});
		return () => {
			alive = false;
		};
	}, [rpc, boardsReady]);
	// Entering the board view lands on the collection home (kimi: the
	// sidebar 看板 entry is the collection set, not the last board).
	const [activeId, setActiveId] = useState<string | null>(null);
	const [savedTick, setSavedTick] = useState(false);
	const [ghost, setGhost] = useState<Ghost | null>(null);
	const [focusWidget, setFocusWidget] = useState<BoardWidget | null>(null);
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const [canvasScale, setCanvasScale] = useState(1);
	const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const ghostRef = useRef<Ghost | null>(null);
	ghostRef.current = ghost;
	// Live drag rect: while a gesture is running the card itself follows
	// the pointer (ghost keeps predicting the next grid snap) — applied
	// for real (and persisted) only on pointerup.
	const [dragRect, setDragRect] = useState<{ id: string; rect: { x: number; y: number; w: number; h: number } } | null>(null);
	const dragRectRef = useRef(dragRect);
	dragRectRef.current = dragRect;

	const persist = (next: BoardData[]): void => {
		setBoards(next);
		try {
			localStorage.setItem(BOARDS_KEY, JSON.stringify(next));
		} catch {
			// session-only
		}
		setSavedTick(true);
		if (savedTimer.current) clearTimeout(savedTimer.current);
		savedTimer.current = setTimeout(() => setSavedTick(false), 1200);
	};

	const active = boards.find(b => b.id === activeId) ?? null;
	const activeRef = useRef<BoardData | null>(null);
	activeRef.current = active;
	// Track the canvas width so the surface scales proportionally (kimi
	// dynamic reflow): scale = containerWidth / BASE_W. Re-runs when the
	// active board mounts the canvas (the ref is null on the home view).
	useEffect(() => {
		const el = canvasRef.current;
		if (!el) return;
		const apply = (): void => {
			const w = el.clientWidth;
			if (w > 0) setCanvasScale(Math.max(0.45, Math.min(3, w / BASE_W)));
		};
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);
	const updateBoard = (id: string, patch: Partial<BoardData>): void => {
		persist(boards.map(b => (b.id === id ? { ...b, ...patch } : b)));
	};

	// Daemon save (fire-and-forget — localStorage already persisted).
	const daemonSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (!rpc || !boardsReady) return;
		if (daemonSaveTimer.current) clearTimeout(daemonSaveTimer.current);
		daemonSaveTimer.current = setTimeout(() => {
			void rpc.request("board.save", { boards }).catch(() => {
				// daemon down — localStorage remains the fallback
			});
		}, 400);
		return () => {
			if (daemonSaveTimer.current) clearTimeout(daemonSaveTimer.current);
		};
	}, [boards, rpc, boardsReady]);

	// Edit mode: cards become selectable and a config panel edits the
	// selected widget's title + data fields (agents design cards; this is
	// the manual fallback for tweaks).
	const [editMode, setEditMode] = useState(false);
	const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);

	// View-swap transition: the leaving view keeps rendering with a
	// blur-out for 150ms, then the target view mounts with a blur-in
	// (dot-matrix particle reassembly is approximated by the blur sweep).
	const [leaving, setLeaving] = useState<"home" | "board" | null>(null);
	const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const viewSwap = (next: () => void, from: "home" | "board"): void => {
		if (leaving === from) return;
		setFocusWidget(null);
		setLeaving(from);
		if (leaveTimer.current) clearTimeout(leaveTimer.current);
		leaveTimer.current = setTimeout(() => {
			setLeaving(null);
			next();
		}, 150);
	};

	const openBoard = (id: string): void => {
		tapFeedback();
		viewSwap(() => {
			setActiveId(id);
			try {
				localStorage.setItem(ACTIVE_KEY, id);
			} catch {
				// ignore
			}
		}, "home");
	};

	// daimon-canvas jump from chat: open the requested board on arrival.
	// Direct setActiveId (no viewSwap's 150ms timer) — the swap animation
	// is already handled App-side; a delayed timer racing the mount-time
	// data effects produced an occasional "Maximum update depth exceeded".
	useEffect(() => {
		if (jumpId) {
			setActiveId(jumpId);
			onJumpConsumed?.();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- jump only on arrival
	}, [jumpId]);
	// Entering the board view always lands on the collection home — the
	// sidebar 看板 entry is the collection set, not the last-opened board.
	const openBoardHome = (): void => {
		viewSwap(() => {
			setActiveId(null);
			try {
				localStorage.removeItem(ACTIVE_KEY);
			} catch {
				// ignore
			}
		}, "board");
	};

	// Widget task run: running spinner → success run recorded.
	const [runningId, setRunningId] = useState<string | null>(null);
	const [taskModalId, setTaskModalId] = useState<string | null>(null);
	const runTask = (w: BoardWidget): void => {
		if (!hasTask(w.data) || runningId) return;
		const t = w.data.task as WidgetTask;
		if (!t.enabled) return;
		setRunningId(w.id);
		setTimeout(() => {
			const now = new Date();
			const time = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
			const next: WidgetTask = { ...t, runs: [{ time, success: true }, ...t.runs].slice(0, 12) };
			updateWidgetData(w.id, { task: next });
			setRunningId(null);
		}, 1400);
	};
	const openTaskModal = (w: BoardWidget): void => {
		if (hasTask(w.data)) setTaskModalId(w.id);
	};
	const taskModalWidget = taskModalId ? (active?.widgets.find(w => w.id === taskModalId) ?? null) : null;

	// Maximized-card close: brief blur-out before unmounting.
	const [focusClosing, setFocusClosing] = useState(false);
	const closeFocus = (): void => {
		if (focusClosing) return;
		setFocusClosing(true);
		setTimeout(() => {
			setFocusWidget(null);
			setFocusClosing(false);
		}, 150);
	};

	/** 整理 — flow-arrange widgets left→right, wrapping at the canvas edge
	 *  (kimi's organize keeps the board tidy in one pass). */
	/** A layout is "tidy" when nothing overlaps and every row already
	 *  reaches the canvas width — organizing it again would only shuffle
	 *  a well-packed board around. */
	const isTidy = (widgets: BoardWidget[]): boolean => {
		const pos = widgets.map(w => w.pos);
		for (let i = 0; i < pos.length; i++) {
			for (let j = i + 1; j < pos.length; j++) {
				const a = pos[i];
				const b = pos[j];
				if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return false;
			}
		}
		// Rows: group by the card's grid row (44px steps, same as SNAP_H).
		const rows = new Map<number, BoardWidget[]>();
		for (const w of widgets) {
			const key = Math.round(w.pos.y / 44);
			const list = rows.get(key) ?? [];
			list.push(w);
			rows.set(key, list);
		}
		const width = BASE_W - GAP;
		for (const [, ws] of rows) {
			const maxRight = Math.max(...ws.map(w => w.pos.x + w.pos.w));
			if (maxRight < width * 0.9) return false;
		}
		return true;
	};

	/** Shelf packing (kimi拼图 style): tallest-first shelves; within a
	 *  shelf fill left→right, then best-fit any leftover gap with cards
	 *  that still fit — small cards tile beside big ones instead of
	 *  leaving holes. */
	const shelfPack = (widgets: BoardWidget[]): BoardWidget[] => {
		const width = BASE_W - GAP;
		const remaining = [...widgets].sort((a, b) => b.pos.h - a.pos.h);
		const placed: BoardWidget[] = [];
		let y = 0;
		while (remaining.length > 0) {
			const shelfH = remaining[0].pos.h;
			let x = 0;
			const rowItems: BoardWidget[] = [];
			// Primary pass: cards no taller than the shelf, left→right.
			let i = 0;
			while (i < remaining.length) {
				const w = remaining[i];
				if (w.pos.h > shelfH) {
					i++;
					continue;
				}
				if (x + w.pos.w <= width) {
					rowItems.push({ ...w, pos: { x, y, w: w.pos.w, h: w.pos.h } });
					x += w.pos.w + 12;
					remaining.splice(i, 1);
				} else {
					i++;
				}
			}
			// Gap fill: leftover space at the row end — best-fit more cards.
			let gap = x;
			let gi = 0;
			while (gi < remaining.length) {
				const w = remaining[gi];
				if (w.pos.h <= shelfH && gap + w.pos.w <= width) {
					rowItems.push({ ...w, pos: { x: gap, y, w: w.pos.w, h: w.pos.h } });
					gap += w.pos.w + 12;
					remaining.splice(gi, 1);
				} else {
					gi++;
				}
			}
			placed.push(...rowItems);
			y += shelfH + 12;
		}
		return placed;
	};

	const organizeBoard = (id: string): void => {
		const board = boards.find(b => b.id === id);
		if (!board || board.widgets.length === 0) return;
		// A tidy board stays untouched — organize only packs messy layouts.
		if (isTidy(board.widgets)) return;
		tapFeedback(2);
		updateBoard(id, { widgets: shelfPack(board.widgets) });
	};

	/** 刷新 — re-read the persisted boards (external changes, reseed). */
	const refreshBoards = (): void => {
		setBoards(loadBoards());
		setSavedTick(false);
	};

	const createBoard = (title: string): void => {
		const id = nextId("b");
		persist([...boards, { id, title, widgets: [] }]);
		openBoard(id);
	};

	const removeBoard = (id: string): void => {
		persist(boards.filter(b => b.id !== id));
		if (activeId === id) {
			setActiveId(null);
			try {
				localStorage.removeItem(ACTIVE_KEY);
			} catch {
				// ignore
			}
		}
	};

	useEffect(() => {
		return () => {
			if (savedTimer.current) clearTimeout(savedTimer.current);
		};
	}, []);

	/** Pointer → canvas base-px (real pixel ÷ scale — the surface scales
	 *  with the window, so stored positions live in base coordinates). */
	const pointerToPx = (clientX: number, clientY: number): { x: number; y: number } => {
		const el = canvasRef.current;
		if (!el) return { x: 0, y: 0 };
		const rect = el.getBoundingClientRect();
		return { x: snap((clientX - rect.left) / canvasScale), y: snap((clientY - rect.top) / canvasScale) };
	};

	type ResizeMode = "resize" | "resize-w" | "resize-h";
	const dragState = useRef<{
		id: string;
		mode: "move" | ResizeMode;
		from: { x: number; y: number; w: number; h: number };
		start: { x: number; y: number };
		moved: boolean;
	} | null>(null);

	// Window-level move/up listeners with capture + blur guards (see the
	// gesture comments in the first review round).
	useEffect(() => {
		const onMove = (e: PointerEvent): void => {
			const s = dragState.current;
			if (!s) return;
			if (!s.moved && Math.hypot(e.clientX - s.start.x, e.clientY - s.start.y) < 6) return;
			if (!s.moved) {
				s.moved = true;
				setGhost({ id: s.id, rect: { ...s.from } });
			}
			const p = pointerToPx(e.clientX, e.clientY);
			// Deltas are base-space (pointerToPx both ends) — the ghost
			// follows the cursor exactly at any canvas scale.
			// Resize steps follow the kimi grid (92 wide / 44 tall); move
			// keeps the fine 8px snap for free positioning.
			const dx = Math.round((p.x - s.start.x) / SNAP_W) * SNAP_W;
			const dy = Math.round((p.y - s.start.y) / SNAP_H) * SNAP_H;
			// Keep the card inside the canvas (right edge and visible
			// bottom); the board is BASE_W wide, height is the visible
			// canvas (cards must not leave the canvas).
			const canvasEl = canvasRef.current;
			// canvasScale can be fractional — the clamp ceiling must be a
			// WHOLE pixel on the 8px grid or resized cards would persist
			// fractional sizes (observed: 301.923647… heights).
			const canvasH = canvasEl ? Math.floor(canvasEl.clientHeight / canvasScale) : 0;
			const clampX = (x: number, w: number): number => Math.max(0, Math.min(x, BASE_W - w));
			// The card's BOTTOM must stay inside the visible canvas, so the
			// clamp ceiling is canvas height minus THIS card's height.
			const clampY = (y: number, h: number): number => Math.max(0, Math.min(y, Math.max(0, canvasH - h)));
			// Height ceiling: 44px grid (−12 gutter form) within the visible
			// canvas, capped at kimi's max card height 1440 (33 rows).
			const hCeil = Math.min(MAX_H, Math.max(MIN_H, Math.floor((canvasH - s.from.y + GAP) / SNAP_H) * SNAP_H - GAP));
			const rect =
				s.mode === "move"
					? {
							x: clampX(s.from.x + dx, s.from.w),
							y: clampY(s.from.y + dy, s.from.h),
							w: s.from.w,
							h: s.from.h,
						}
					: s.mode === "resize-w"
						? { x: s.from.x, y: s.from.y, w: Math.max(MIN_W, Math.min(s.from.w + dx, BASE_W - s.from.x)), h: s.from.h }
						: s.mode === "resize-h"
							? { x: s.from.x, y: s.from.y, w: s.from.w, h: Math.max(MIN_H, Math.min(s.from.h + dy, hCeil)) }
							: {
									x: s.from.x,
									y: s.from.y,
									w: Math.max(MIN_W, Math.min(s.from.w + dx, BASE_W - s.from.x)),
									h: Math.max(MIN_H, Math.min(s.from.h + dy, hCeil)),
								};
			setGhost({ id: s.id, rect });
			// Live follow: the card itself resizes with the pointer (the
			// ghost still previews the snapped target); committed on up.
			setDragRect({ id: s.id, rect });
		};
		const onUp = (): void => {
			const s = dragState.current;
			if (!s) return;
			dragState.current = null;
			const g = ghostRef.current;
			setGhost(null);
			setDragRect(null);
			if (g && s.moved && activeRef.current) {
				// Apply the moved card's final rect, then push every
				// colliding card down so nothing overlaps.
				const moved = activeRef.current.widgets.find(w => w.id === s.id);
				if (moved) {
					// Whole-pixel guarantee: positions are exact integers on
					// the pixel canvas (transitions may be smooth, state is not).
					const rect = {
						x: Math.round(g.rect.x),
						y: Math.round(g.rect.y),
						w: Math.round(g.rect.w),
						h: Math.round(g.rect.h),
					};
					const withMoved = activeRef.current.widgets.map(w =>
						w.id === s.id ? { ...w, pos: rect } : w,
					);
					const resolved = resolveCollisions(withMoved, { ...moved, pos: { ...g.rect } }, s.id);
					updateBoard(activeRef.current.id, { widgets: resolved });
				}
			}
		};
		const onBlur = (): void => {
			if (dragState.current) {
				dragState.current = null;
				setGhost(null);
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			window.removeEventListener("blur", onBlur);
		};
	}, [active]);

	const onPointerDown = (e: React.PointerEvent, w: BoardWidget, mode: "move" | ResizeMode): void => {
		if (!active) return;
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			// capture unsupported — window listeners still work in-window
		}
		// start lives in BASE coordinates (pointerToPx) so the move delta
		// is scale-correct — mixing screen px into the base-space rect was
		// making the ghost drift away from the cursor (scale ≠ 1).
		const startPx = pointerToPx(e.clientX, e.clientY);
		dragState.current = { id: w.id, mode, from: { ...w.pos }, start: { x: startPx.x, y: startPx.y }, moved: false };
	};

	if (!active) {
		return (
			<div className="gui-board">
				<BoardHome
							boards={boards}
							onOpen={openBoard}
							onCreate={createBoard}
							onDelete={removeBoard}
							onChatCreate={text => onChatCreate?.(text)}
						/>
			</div>
		);
	}

	const pinWidget = (w: BoardWidget): void => {
		tapFeedback();
		// 固定至桌面 (M5 skeleton): open a small always-on-top Electron
		// window showing the card. The pin IPC carries the card payload.
		try {
			const api = (window as unknown as { electronAPI?: { pinWidget?(payload: unknown): Promise<unknown> } }).electronAPI;
			// Pass the card's board-space size so the pinned window opens at
			// the same aspect (main scales it down to desktop-card bounds).
			void api?.pinWidget?.({ title: w.title, type: w.type, data: w.data, w: w.pos.w, h: w.pos.h });
		} catch {
			// plain browser — no desktop bridge
		}
	};

	const addWidget = (type: string): void => {
		const wgt = makeAndPlace(active.widgets, type);
		updateBoard(active.id, { widgets: [...active.widgets, wgt] });
	};
	const removeWidget = (id: string): void => {
		updateBoard(active.id, { widgets: active.widgets.filter(w => w.id !== id) });
	};
	const renameWidget = (id: string, title: string): void => {
		updateBoard(active.id, { widgets: active.widgets.map(w => (w.id === id ? { ...w, title } : w)) });
	};
	const updateWidgetData = (id: string, patch: Record<string, unknown>): void => {
		updateBoard(active.id, {
			widgets: active.widgets.map(w => (w.id === id ? { ...w, data: { ...w.data, ...patch } } : w)),
		});
	};

	// Board view JSX (active is non-null here) — rendered for the
	// leave/enter transition frames below.
	const boardView = (
		<div className="gui-board">
			<div className="gui-board-head">
				<button
					type="button"
					className="gui-tool-btn"
					onClick={openBoardHome}
					aria-label={t("back")}
					title={t("back")}
				>
					<Icon name="arrow-left" className="h-4 w-4" />
				</button>
				<div className="gui-board-title-wrap">
					<input
						className="gui-board-title"
						value={active.title}
						onChange={e => updateBoard(active.id, { title: e.target.value })}
						aria-label={t("board title")}
					/>
					{savedTick && <span className="gui-board-saved">{t("saved")}</span>}
				</div>
				<div className="gui-board-actions">
					<button
						type="button"
						className={`gui-tool-btn${editMode ? " gui-tool-btn--active" : ""}`}
						disabled={active.builtin === true}
						title={active.builtin ? t("board builtin") : t("board edit")}
						aria-label={t("board edit")}
						onClick={() => {
							setEditMode(v => !v);
							setSelectedWidgetId(null);
						}}
					>
						<Icon name="pencil" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="gui-tool-btn"
						onClick={() => organizeBoard(active.id)}
						title={t("board organize")}
						aria-label={t("board organize")}
					>
						<Icon name="layout-column" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="gui-tool-btn"
						onClick={refreshBoards}
						title={t("board refresh")}
						aria-label={t("board refresh")}
					>
						<Icon name="refresh" className="h-4 w-4" />
					</button>
					<button type="button" className="gui-btn" onClick={onBack}>
						{t("back to workspace")}
					</button>
				</div>
			</div>
			<div className="gui-board-canvas" ref={canvasRef}>
				<div className="gui-board-surface" style={{ width: BASE_W, transform: `scale(${canvasScale})` }}>
				{active.widgets.length === 0 && (
					<div className="gui-board-empty">
						<div className="gui-board-empty-title">{t("board empty title")}</div>
						<div className="gui-board-empty-desc">{t("board empty desc")}</div>
					</div>
				)}
				{ghost && (
					<div
						className="gui-board-ghost"
						style={{ left: ghost.rect.x, top: ghost.rect.y, width: ghost.rect.w, height: ghost.rect.h }}
					/>
				)}
				{active.widgets.map(w => {
					const def = widgetDef(w.type);
					if (!def) return null;
					const dimmed = ghost !== null && ghost.id !== w.id;
					return (
						<div
							key={w.id}
							className={`gui-board-card${dimmed ? " gui-board-card--dimmed" : ""}${editMode && selectedWidgetId === w.id ? " gui-board-card--selected" : ""}`}
							data-tone={def.tone ?? "default"}
							style={{
								left: dragRect?.id === w.id ? dragRect.rect.x : w.pos.x,
								top: dragRect?.id === w.id ? dragRect.rect.y : w.pos.y,
								width: dragRect?.id === w.id ? dragRect.rect.w : w.pos.w,
								height: dragRect?.id === w.id ? dragRect.rect.h : w.pos.h,
							}}
							onClick={editMode ? () => setSelectedWidgetId(w.id) : undefined}
						>
							<SpotlightCard className="gui-board-card-inner" spotlightColor="rgba(255, 255, 255, 0.07)">
								<div className="gui-board-card-head" onPointerDown={e => onPointerDown(e, w, "move")}>
									<input
										className="gui-board-card-title"
										value={w.title}
										onChange={e => renameWidget(w.id, e.target.value)}
										aria-label={t("widget title")}
									/>
									<div className="gui-board-card-actions">
										{hasTask(w.data) && (
											<button
												type="button"
												className={`gui-board-card-act${runningId === w.id ? " gui-board-card-act--running" : ""}`}
												aria-label={t("widget run")}
												title={t("widget run")}
												onPointerDown={e => e.stopPropagation()}
												onClick={() => runTask(w)}
											>
												<Icon name={runningId === w.id ? "loader" : "play"} className="h-3.5 w-3.5" />
											</button>
										)}
										<button
											type="button"
											className="gui-board-card-act"
											aria-label={t("widget focus")}
											title={t("widget focus")}
											onPointerDown={e => e.stopPropagation()}
											onClick={() => setFocusWidget(w)}
										>
											<Icon name="fullscreen" className="h-3.5 w-3.5" />
										</button>
										<CardMenuButton
											onPin={() => pinWidget(w)}
											onDelete={() => removeWidget(w.id)}
											onViewTask={widgetHasTask(w.data) ? () => openTaskModal(w) : undefined}
										/>
									</div>
								</div>
								<div className="gui-board-card-body">
									<WidgetFit>
										<WidgetErrorBoundary>
											<def.Component data={w.data} update={patch => updateWidgetData(w.id, patch)} />
										</WidgetErrorBoundary>
									</WidgetFit>
								</div>
								{/* Edge/corner resize: right and bottom edges drag
								 * independently, the corner both — 8px steps. */}
								<div className="gui-board-card-resize-e" onPointerDown={e => onPointerDown(e, w, "resize-w")} />
								<div className="gui-board-card-resize-s" onPointerDown={e => onPointerDown(e, w, "resize-h")} />
								<div className="gui-board-card-resize" onPointerDown={e => onPointerDown(e, w, "resize")} />
								<span className="gui-board-card-size">
									{dragRect?.id === w.id ? dragRect.rect.w : w.pos.w} × {dragRect?.id === w.id ? dragRect.rect.h : w.pos.h}
								</span>
							</SpotlightCard>
						</div>
					);
				})}
				</div>
			</div>
			{editMode && (
				<WidgetEditor
					boards={boards}
					activeId={active.id}
					selectedId={selectedWidgetId}
					onSelect={setSelectedWidgetId}
					onUpdate={(id, patch) => updateWidgetData(id, patch)}
					onRename={(id, title) => renameWidget(id, title)}
					onDelete={removeWidget}
					onAdd={addWidget}
					onClose={() => {
						setEditMode(false);
						setSelectedWidgetId(null);
					}}
				/>
			)}
			{taskModalWidget && (
				<TaskModal
					task={taskModalWidget.data.task as WidgetTask}
					update={patch => updateWidgetData(taskModalWidget.id, patch)}
					onClose={() => setTaskModalId(null)}
				/>
			)}
			{focusWidget && (
				<div className={`gui-board-focus${focusClosing ? " gui-board-focus--closing" : ""}`} role="dialog" aria-modal="true" onClick={closeFocus}>
					<div
						className="gui-board-focus-card"
						data-tone={widgetDef(focusWidget.type)?.tone ?? "default"}
						style={focusCardSize()}
						onClick={e => e.stopPropagation()}
					>
						<div className="gui-board-focus-head">
							<input
								className="gui-board-focus-title"
								value={focusWidget.title}
								onChange={e => renameWidget(focusWidget.id, e.target.value)}
								aria-label={t("widget title")}
							/>
							<div className="gui-board-focus-actions">
								{hasTask(focusWidget.data) && (
									<button
										type="button"
										className={`gui-tool-btn${runningId === focusWidget.id ? " gui-tool-btn--running" : ""}`}
										title={t("widget run")}
										aria-label={t("widget run")}
										onClick={() => runTask(focusWidget)}
									>
										<Icon name={runningId === focusWidget.id ? "loader" : "play"} className="h-3.5 w-3.5" />
									</button>
								)}
								<button
									type="button"
									className="gui-tool-btn"
									title={t("widget pin to desktop")}
									aria-label={t("widget pin to desktop")}
									onClick={() => pinWidget(focusWidget)}
								>
									<Icon name="pushpin" className="h-3.5 w-3.5" />
								</button>
								<CardMenuButton
									onPin={() => pinWidget(focusWidget)}
									onDelete={() => {
										removeWidget(focusWidget.id);
										closeFocus();
									}}
									onViewTask={widgetHasTask(focusWidget.data) ? () => openTaskModal(focusWidget) : undefined}
								/>
								<button
									type="button"
									className="gui-tool-btn"
									onClick={closeFocus}
									aria-label={t("close")}
								>
									<Icon name="close" className="h-4 w-4" />
								</button>
							</div>
						</div>
						<div className="gui-board-focus-body">
							{(() => {
								const Comp = widgetDef(focusWidget.type)?.Component;
								if (!Comp) return null;
								// JSX (not a bare call): widget components carry
								// hooks (pomodoro timer) and a direct function
								// invocation violates the rules of hooks — the
								// modal went blank. WidgetFit keeps the widget's
								// natural content fully visible at any size.
								return (
									<WidgetFit>
										<WidgetErrorBoundary>
											<Comp
												data={focusWidget.data}
												update={patch => {
													updateWidgetData(focusWidget.id, patch);
													setFocusWidget(f => (f ? { ...f, data: { ...f.data, ...patch } } : f));
												}}
											/>
										</WidgetErrorBoundary>
									</WidgetFit>
								);
							})()}
						</div>
					</div>
				</div>
			)}
		</div>
	);

	// View transitions: home ↔ board blur-swap (150ms leave + 300ms enter);
	// the leaving view keeps rendering so its fade can play.
	if (leaving === "board" && active) {
		return (
			<div className="gui-board">
				<div className="gui-view-leave">{boardView}</div>
			</div>
		);
	}
	if (leaving === "home") {
		return (
			<div className="gui-board">
				<div className="gui-view-leave">
					<BoardHome
							boards={boards}
							onOpen={openBoard}
							onCreate={createBoard}
							onDelete={removeBoard}
							onChatCreate={text => onChatCreate?.(text)}
						/>
				</div>
			</div>
		);
	}
	if (!active) {
		return (
			<div className="gui-board">
				<div className="gui-view-enter">
					<BoardHome
							boards={boards}
							onOpen={openBoard}
							onCreate={createBoard}
							onDelete={removeBoard}
							onChatCreate={text => onChatCreate?.(text)}
						/>
				</div>
			</div>
		);
	}
	return (
		<div className="gui-board">
			<div className="gui-view-enter">{boardView}</div>
		</div>
	);
}
