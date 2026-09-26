import { t, tLoose } from "@musepi/client-core";
import { replaceTabs } from "@musepi/client-core/src/tool-render/util";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { timeFormatOptions } from "../lib/appearance";
import { Icon } from "../vendor/oc-icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { durationText, TimelineOverview, type TimelineRange } from "./TimelineOverview";
import { buildTrajectoryTree, type RoundDurationMap, type TrajectoryEvent } from "./trajectory-data";
import {
	layoutTurnMap,
	TURN_LANE_GAP,
	TURN_NODE_COMPACT_H,
	TURN_NODE_H,
	TURN_NODE_W,
	type TurnMapDirection,
	type TurnMapNode,
	visibleTurnMapNodes,
} from "./turn-map-layout";

/**
 * 轮级会话地图(0.5.0-map-redesign 设计稿实现):投影单位 = 轮(与折叠/
 * 导航/轨迹同一 isTurnStart 口径),164 轮 = 164 个玻璃节点卡。主线时间轴
 * (金色流动渐变连线),重答/分叉轮开列分支(金→紫渐变支线);单击切换
 * 轮卡折叠/展开(折叠 = 单行紧凑卡,展开 = 全卡 + 轮内事件泳道),双击
 * 跳回对话定位该轮,左侧(横向模式为底部)迷你导航条 = 全轮次剪影。
 * 消息级画布(SessionTreeCanvas)已下线——单一轮级视图。
 *
 * 性能:节点数 = 轮数(≤ 数百),布局 O(n);进入视图无整树 mount 卡顿。
 */

const FIT_PADDING = 28;
/** 大树自适应缩放下限:超出交给平移,不把卡片缩成细条(设计稿验收 2)。 */
const MIN_FIT_SCALE = 0.75;
const MIN_SCALE = 0.08;
const MAX_SCALE = 2.2;

/** 方向持久化键(读不到/非法值默认纵向)。 */
const MAP_DIRECTION_KEY = "musepi.map.direction";

function readMapDirection(): TurnMapDirection {
	try {
		return localStorage.getItem(MAP_DIRECTION_KEY) === "h" ? "h" : "v";
	} catch {
		return "v";
	}
}

/** 轮摘要:轮首非 system 事件的标题(设计稿 = 轮起始消息摘要,90 字截断)。 */
function turnSummaryOf(group: TurnMapNode["group"]): string {
	const ev = group.events.find(e => e.kind !== "system") ?? group.events[0];
	return (ev?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
}

/** 轮内事件构成(kind → 计数,迷你泳道分段宽度∝计数)。 */
function compositionOf(group: TurnMapNode["group"]): { kind: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const ev of group.events) {
		const kind = ev.kind === "system" ? "assistant" : ev.kind;
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/** 轮统计:回复(assistant)数 · 工具数 · 用时(roundDurations 优先,无则首末事件差)。 */
function turnStatsOf(group: TurnMapNode["group"]): { replies: number; tools: number; durationMs?: number } {
	const replies = group.events.filter(e => e.kind === "assistant").length;
	const tools = group.events.filter(e => e.kind === "tool").length;
	const durationMs =
		group.roundDurationMs ??
		(group.startMs !== undefined && group.endMs !== undefined ? group.endMs - group.startMs : undefined);
	return { replies, tools, durationMs };
}

/** 轮跳转锚:轮内首个带 entryId 的事件(双击跳对话用)。 */
function jumpEventOf(group: TurnMapNode["group"]): TrajectoryEvent | undefined {
	return group.events.find(e => e.entryId !== undefined);
}

/** token 数缩写(1.2k 形态;TUI /trace 信息密度,GUI 排版)。 */
function compactTokens(n: number): string {
	if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** 工具参数摘要:tab 净化 + 空白折叠(body 已是 160 字截断的 JSON)。 */
function toolArgsSummary(ev: TrajectoryEvent): string | null {
	if (ev.kind !== "tool" || !ev.body) return null;
	const s = replaceTabs(ev.body).replace(/\s+/g, " ").trim();
	return s ? s : null;
}

/**
 * 节点卡(memo):视口裁剪 + 卡级 memo 双重挡重渲染。两态渲染:
 * 折叠 = 单行紧凑卡(徽章 + 摘要 + 计数 + 用时);展开 = 全卡 + 泳道
 * (事件行带工具参数摘要 / usage / duration / ttft,trace 对齐)。
 * 导出仅供测试断言两态渲染契约。
 */
export const TmNodeCard = memo(function TmNodeCard({
	n,
	isLeaf,
	isCurrent,
	isExpanded,
	searchDim,
	searchHit,
	onToggle,
	onJump,
	onMenu,
	onHover,
}: {
	n: TurnMapNode;
	isLeaf: boolean;
	isCurrent: boolean;
	isExpanded: boolean;
	searchDim: boolean;
	searchHit: boolean;
	onToggle(turn: number): void;
	onJump(node: TurnMapNode): void;
	onMenu(node: TurnMapNode, x: number, y: number): void;
	onHover(node: TurnMapNode | null): void;
}): ReactNode {
	const summary = useMemo(() => turnSummaryOf(n.group), [n.group]);
	const statsRow = useMemo(() => turnStatsOf(n.group), [n.group]);
	const comp = useMemo(() => compositionOf(n.group), [n.group]);
	// 展示编号 = 树深度(分支后会话按新主线重新编号);无 pathTurn 回退 journal 序。
	const shownTurn = n.group.displayTurn ?? n.group.turn;
	return (
		<div
			className={`tm-node${isExpanded ? "" : " tm-node--compact"}${n.branch ? " tm-node--branch" : ""}${isLeaf ? " tm-node--leaf" : ""}${isCurrent ? " tm-node--current" : ""}${searchDim ? " tm-node--dim" : ""}${searchHit ? " tm-node--hit" : ""}`}
			style={{ left: n.x, top: n.y, width: TURN_NODE_W, height: n.h }}
			onClick={() => onToggle(n.group.turn)}
			onDoubleClick={() => onJump(n)}
			onContextMenu={e => {
				e.preventDefault();
				e.stopPropagation();
				onMenu(n, e.clientX, e.clientY);
			}}
			onMouseEnter={() => onHover(n)}
			onMouseLeave={() => onHover(null)}
		>
			{isExpanded ? (
				<>
					<div className="tm-node-head">
						<span className={`tm-turn-badge${n.advisor ? " tm-turn-badge--advisor" : ""}`}>
							{n.group.turn === 0 ? t("trajectory system events") : `Turn ${shownTurn}`}
							{n.advisor && (
								<em className="tm-turn-advisor">
									<Icon name="sparkling" className="h-2.5 w-2.5" />
									{t("advisor")}
								</em>
							)}
						</span>
						{statsRow.durationMs !== undefined && (
							<span className="tm-node-dur">{durationText(statsRow.durationMs)}</span>
						)}
					</div>
					<div className="tm-node-summary" title={summary}>
						{summary || `${n.group.events.length} events`}
					</div>
					{/* 构成条:轮内事件 kind 四色分段(脉络感的主要来源)。 */}
					<div className="tm-comp" aria-hidden>
						{comp.map((seg, i) => (
							<span
								key={`${seg.kind}-${i}`}
								className={`tm-comp-seg tm-comp--${seg.kind}`}
								style={{ width: `${(seg.count / n.group.events.length) * 100}%` }}
							/>
						))}
					</div>
					<div className="tm-node-stats">
						{tLoose("turn map replies", { count: statsRow.replies })} ·{" "}
						{tLoose("turn map tools", { count: statsRow.tools })}
					</div>
					{/* 轮内泳道(单击展开):该轮事件行,与轨迹检视器同 i18n/颜色。
						明细 = trace 对齐:工具参数摘要、assistant usage/duration/ttft。 */}
					<div className="tm-lane" onWheel={e => e.stopPropagation()}>
						{n.group.events.map(ev => {
							const args = toolArgsSummary(ev);
							return (
								<div key={ev.id} className={`tm-lane-row tm-lane-row--${ev.kind}`}>
									<span className="tm-lane-dot" />
									<span className="tm-lane-title" title={args ?? ev.body ?? ev.title}>
										{ev.kind === "tool" ? ev.title : (ev.body ?? ev.title)}
									</span>
									{args && (
										<span className="tm-lane-args" title={args}>
											{args}
										</span>
									)}
									{ev.kind === "assistant" && ev.usage && (
										<span className="tm-lane-usage" title={`↑${ev.usage.input} ↓${ev.usage.output}`}>
											↑{compactTokens(ev.usage.input)} ↓{compactTokens(ev.usage.output)}
										</span>
									)}
									{ev.durationMs !== undefined && (
										<span className="tm-lane-meta">{durationText(ev.durationMs)}</span>
									)}
									{ev.ttftMs !== undefined && (
										<span className="tm-lane-meta" title="TTFT">
											ttft {durationText(ev.ttftMs)}
										</span>
									)}
									{ev.tsMs !== undefined && (
										<span className="tm-lane-time">
											{new Date(ev.tsMs).toLocaleTimeString(undefined, timeFormatOptions())}
										</span>
									)}
								</div>
							);
						})}
					</div>
				</>
			) : (
				<div className="tm-compact">
					<span className={`tm-turn-badge${n.advisor ? " tm-turn-badge--advisor" : ""}`}>
						{n.group.turn === 0 ? t("trajectory system events") : `Turn ${shownTurn}`}
					</span>
					<span className="tm-compact-summary" title={summary}>
						{summary || `${n.group.events.length} events`}
					</span>
					<span className="tm-compact-count">
						{tLoose("turn map compact count", { count: n.group.events.length })}
					</span>
					{statsRow.durationMs !== undefined && (
						<span className="tm-node-dur">{durationText(statsRow.durationMs)}</span>
					)}
				</div>
			)}
		</div>
	);
});

export function TurnMapCanvas({
	entries,
	roundDurations,
	leafId,
	activePathIds,
	loading,
	onJumpToEntry,
	onSwitchToBranch,
	onBranchTo,
	onForkAt,
}: {
	entries: readonly unknown[];
	/** daemon agent_end 冻结的整轮用时(Map 或持久化 [ms,ms][] 形态)。 */
	roundDurations?: RoundDurationMap;
	/** 当前叶子(view key id;null = 尾部跟随)。 */
	leafId?: string | null;
	/** 活动路径 id 集;用于当前轮高亮。 */
	activePathIds?: ReadonlySet<string>;
	/** 全量历史补全中(尾窗数据先渲染,补全后整体替换)。 */
	loading?: boolean;
	/** 双击/右键跳转:跳回对话并定位该轮(父层切回 chat + requestJump)。 */
	onJumpToEntry?: (entryId: string) => void;
	/** 切换到此分支:移动会话叶子到该轮(session.branchAt,显式树操作)。 */
	onSwitchToBranch?: (entryId: string) => void;
	/** 重答该轮(锚 = 轮首事件 entryId)。 */
	onBranchTo?: (entryId: string) => void;
	/** 从该轮分叉新会话。 */
	onForkAt?: (entryId: string) => void;
}): ReactNode {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
	const dragRef = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean } | null>(null);
	const [dragging, setDragging] = useState(false);
	// 单击/双击消歧(单击 = 切换折叠,双击 = 跳对话)。
	const singleClickTimer = useRef<number | undefined>(undefined);
	// 折叠/展开状态机(会话内内存态,不进 URL/持久化):集合内 = 展开泳道。
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
	// 右键菜单。
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TurnMapNode | null } | null>(null);
	// 搜索命中轮高亮。
	const [searchQuery, setSearchQuery] = useState("");
	// 悬停浮卡(轮首消息全文 + 首末时刻)。
	const [hoverNode, setHoverNode] = useState<TurnMapNode | null>(null);
	// 方向(v = 主线垂直默认;h = 主线水平),localStorage 持久化。
	const [direction, setDirection] = useState<TurnMapDirection>(readMapDirection);
	const horizontal = direction === "h";

	// activePathIds 提供时:主线/分支按活跃叶路径判定,轮号 = 树深度
	// (branchAt 后新主线轮重新编号,废弃分支入分支列);无 = 旧 first-child 启发式。
	const { turns, stats } = useMemo(
		() => buildTrajectoryTree(entries, roundDurations, activePathIds),
		[entries, roundDurations, activePathIds],
	);
	const layout = useMemo(() => layoutTurnMap(turns, expanded, direction), [turns, expanded, direction]);
	const { nodes, edges, main, width, height } = layout;

	// 当前轮:活动路径上最靠后的主线轮(无路径信息 = 主线尾轮)。
	const currentTurn = useMemo(() => {
		if (activePathIds) {
			for (let i = main.length - 1; i >= 0; i--) {
				if (main[i]!.group.events.some(e => e.entryId !== undefined && activePathIds.has(e.entryId))) {
					return main[i]!.group.turn;
				}
			}
		}
		return main[main.length - 1]?.group.turn ?? null;
	}, [main, activePathIds]);
	// 叶子轮(会话尾)= 主线最后一轮:金色发光描边。
	const leafTurn = main[main.length - 1]?.group.turn ?? null;

	// 搜索:命中轮摘要高亮、其余淡显。
	const searchMatchTurns = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return null;
		const set = new Set<number>();
		for (const n of nodes) {
			if (turnSummaryOf(n.group).toLowerCase().includes(q)) set.add(n.group.turn);
		}
		return set;
	}, [searchQuery, nodes]);

	// ── 视口:fit-all(全部可见)或大树智能适配(可读缩放 + 当前轮居中) ──
	const needsFitRef = useRef(true);
	const fitView = useCallback((): void => {
		const wrap = wrapRef.current;
		if (!wrap || width === 0 || height === 0) return;
		const cw = wrap.clientWidth;
		const ch = wrap.clientHeight;
		if (cw < 80 || ch < 80) return;
		needsFitRef.current = false;
		const fullScale = Math.min((cw - FIT_PADDING * 2) / width, (ch - FIT_PADDING * 2) / height, 1);
		if (fullScale >= 0.55) {
			const scaledW = width * fullScale;
			const scaledH = height * fullScale;
			setView({
				scale: fullScale,
				x: (cw - scaledW) / 2,
				y: (ch - scaledH) / 2,
			});
			return;
		}
		// 大树:主轴超出 → 可读缩放,当前轮居中("我在哪"优先于看全图)。
		// v = 纵向超出按宽适配;h = 横向超出按高适配。
		const focus = nodes.find(n => n.group.turn === currentTurn) ?? main[main.length - 1] ?? null;
		const fx = (focus?.x ?? 0) + TURN_NODE_W / 2;
		const fy = (focus?.y ?? 0) + (horizontal ? TURN_NODE_COMPACT_H / 2 : TURN_NODE_H / 2);
		const axisFit = horizontal ? (ch - FIT_PADDING * 2) / height : (cw - FIT_PADDING * 2) / width;
		const scale = Math.min(1, Math.max(MIN_FIT_SCALE, axisFit));
		setView({ scale, x: cw / 2 - fx * scale, y: ch / 2 - fy * scale });
	}, [width, height, nodes, currentTurn, main, horizontal]);
	// 容器尺寸(state 化):视口裁剪与 fit 几何都依赖它,放 state 里保证
	// 变化触发重算(RO 回调里同步 set,首帧 0 → mount 后即刻修正)。
	const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		const ro = new ResizeObserver(() => {
			setWrapSize({ w: wrap.clientWidth, h: wrap.clientHeight });
			if (needsFitRef.current) fitView();
		});
		ro.observe(wrap);
		if (needsFitRef.current) fitView();
		return () => ro.disconnect();
	}, [fitView]);

	// 视口裁剪:只渲染可见世界矩形内的节点卡(画布版「渐进挂载」)。
	// 164 轮全量卡 ≈ 1600+ DOM;裁剪后视口内通常只有十几张。view 每帧
	// 变化(pan/zoom)都重算一次,O(n) filter 可忽略;memo 节点卡挡住
	// hover 浮卡等状态变化的整树重渲染。
	const visibleNodes = useMemo(() => {
		const { w, h } = wrapSize;
		if (w === 0 || h === 0) return nodes;
		const vp = {
			left: -view.x / view.scale,
			top: -view.y / view.scale,
			right: (w - view.x) / view.scale,
			bottom: (h - view.y) / view.scale,
		};
		return visibleTurnMapNodes(nodes, vp);
	}, [nodes, view, wrapSize]);
	const visibleTurns = useMemo(() => new Set(visibleNodes.map(n => n.group.turn)), [visibleNodes]);
	// 全量历史补全落地 / 新轮出现:重新适配。以 turns.length 为信号而不是
	// entries 身份——ChatView 的 overviewEntries 现在是活合并,流式期间每帧
	// 替换条目对象,身份每帧都变;按身份 refit 会让地图在流式期间每帧重新
	// 适配(抖动)。轮数变化(尾窗→全量、新分支长出新一轮)才是真正需要
	// 重新适配的时刻;撤回/切分支只改路径不改轮数,视野保持不动。
	const turnCountRef = useRef(turns.length);
	useEffect(() => {
		if (turnCountRef.current === turns.length) return;
		turnCountRef.current = turns.length;
		needsFitRef.current = true;
		fitView();
	}, [turns.length, fitView]);
	// 方向切换:几何转置,旧视野不成立——重新适配。
	useEffect(() => {
		needsFitRef.current = true;
		fitView();
	}, [direction, fitView]);

	const centerOnTurn = useCallback(
		(turn: number, targetScale?: number): void => {
			const wrap = wrapRef.current;
			const n = nodes.find(m => m.group.turn === turn);
			if (!wrap || !n) return;
			// v:以卡宽+车道距估可读缩放;h:以卡高+行距估。
			const readable = horizontal
				? wrap.clientHeight / (TURN_NODE_H + TURN_LANE_GAP * 2)
				: wrap.clientWidth / (TURN_NODE_W + TURN_LANE_GAP * 2);
			const scale = targetScale ?? Math.max(0.7, Math.min(1.2, readable));
			setView({
				scale,
				x: wrap.clientWidth / 2 - (n.x + TURN_NODE_W / 2) * scale,
				y: wrap.clientHeight / 2 - (n.y + n.h / 2) * scale,
			});
		},
		[nodes, horizontal],
	);

	// 滚轮缩放(原生 non-passive,preventDefault 阻止背后页面滚动;
	// 画布内可滚内容——展开的轮内泳道——优先滚动,不缩放)。
	const onWheel = useCallback((e: WheelEvent) => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		for (let el = e.target as HTMLElement | null; el && el !== wrap; el = el.parentElement) {
			const overflowY = getComputedStyle(el).overflowY;
			if (/(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) return;
		}
		e.preventDefault();
		const rect = wrap.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		setView(v => {
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
			const k = scale / v.scale;
			return { scale, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
		});
	}, []);
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		wrap.addEventListener("wheel", onWheel, { passive: false });
		return () => wrap.removeEventListener("wheel", onWheel);
	}, [onWheel]);

	// 空白拖拽平移(节点卡/控件上不启动)。
	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			if (target.closest(".tm-node, .tm-hover, .tm-topbar, .tm-nav, .tm-zoom, .tm-search, .gui-context-menu"))
				return;
			dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false };
			setDragging(true);
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		},
		[view.x, view.y],
	);
	const onPointerMove = useCallback((e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		const dx = e.clientX - d.px;
		const dy = e.clientY - d.py;
		if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
		setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
	}, []);
	const suppressClick = useRef(false);
	const onPointerUp = useCallback(() => {
		suppressClick.current = dragRef.current?.moved ?? false;
		dragRef.current = null;
		setDragging(false);
	}, []);

	// 单击 = 切换折叠/展开;双击 = 跳对话。
	const handleClick = useCallback((turn: number) => {
		const suppressed = suppressClick.current;
		suppressClick.current = false;
		if (suppressed) return;
		clearTimeout(singleClickTimer.current);
		singleClickTimer.current = window.setTimeout(() => {
			singleClickTimer.current = undefined;
			setExpanded(prev => {
				const next = new Set(prev);
				if (next.has(turn)) next.delete(turn);
				else next.add(turn);
				return next;
			});
		}, 220);
	}, []);
	const handleDblClick = useCallback(
		(node: TurnMapNode) => {
			const suppressed = suppressClick.current;
			suppressClick.current = false;
			if (suppressed) return;
			clearTimeout(singleClickTimer.current);
			singleClickTimer.current = undefined;
			const ev = jumpEventOf(node.group);
			if (ev?.entryId && onJumpToEntry) onJumpToEntry(ev.entryId);
		},
		[onJumpToEntry],
	);
	// 节点右键菜单(stable,供 memo 卡引用)。
	const openNodeMenu = useCallback((node: TurnMapNode, x: number, y: number) => {
		setCtxMenu({ x, y, node });
	}, []);

	// 顶栏批量折叠/展开 + 方向切换。
	const allTurns = useMemo(() => new Set(nodes.map(n => n.group.turn)), [nodes]);
	const anyExpanded = expanded.size > 0;
	const toggleAll = useCallback(() => {
		setExpanded(anyExpanded ? new Set() : allTurns);
	}, [anyExpanded, allTurns]);
	const switchDirection = useCallback(() => {
		setDirection(d => {
			const next = d === "v" ? "h" : "v";
			try {
				localStorage.setItem(MAP_DIRECTION_KEY, next);
			} catch {
				// localStorage 不可用(隐私模式)——仅会话内生效。
			}
			return next;
		});
	}, []);

	// 右键菜单:节点 = 跳转/切换分支/重答/分叉;空白 = 适配视图。
	// 语义:跳转 = 纯导航(不动 leaf);切换到此分支/重答/分叉 = 树操作
	// (父层已套运行中保护)。
	const ctxItems = useMemo<ContextMenuItem[]>(() => {
		if (!ctxMenu) return [];
		if (ctxMenu.node !== null) {
			const node = ctxMenu.node;
			const ev = jumpEventOf(node.group);
			const items: ContextMenuItem[] = [];
			if (ev?.entryId && onJumpToEntry) {
				items.push({
					label: t("trajectory jump"),
					description: t("context jump desc"),
					icon: "arrow-go-forward",
					onSelect: () => onJumpToEntry(ev.entryId!),
				});
			}
			if (ev?.entryId && onSwitchToBranch) {
				items.push({
					label: t("map switch to branch"),
					description: t("map switch to branch desc"),
					icon: "git-merge",
					onSelect: () => onSwitchToBranch(ev.entryId!),
				});
			}
			if (ev?.entryId && onBranchTo) {
				items.push({
					label: t("branch re-answer here"),
					description: t("context branch desc"),
					icon: "git-branch",
					onSelect: () => onBranchTo(ev.entryId!),
				});
			}
			if (ev?.entryId && onForkAt) {
				items.push({
					label: t("fork session here"),
					description: t("context fork desc"),
					icon: "git-fork",
					onSelect: () => onForkAt(ev.entryId!),
				});
			}
			return items;
		}
		return [
			{
				label: t("canvas reset view"),
				description: t("context reset desc"),
				icon: "align-justify",
				onSelect: () => {
					needsFitRef.current = true;
					fitView();
				},
			},
		];
	}, [ctxMenu, onJumpToEntry, onSwitchToBranch, onBranchTo, onForkAt, fitView]);

	// 顶部时间轴:拖拽区间聚焦 / 单击整轮定位(轨迹检视器同款交互)。
	const [range, setRange] = useState<TimelineRange | null>(null);
	useEffect(() => {
		if (!range) return;
		for (const n of nodes) {
			if (n.group.events.some(e => e.tsMs !== undefined && e.tsMs >= range.startMs && e.tsMs <= range.endMs)) {
				centerOnTurn(n.group.turn);
				break;
			}
		}
	}, [range, nodes, centerOnTurn]);

	const hasSearch = searchQuery.trim().length > 0;

	// 迷你导航条几何:整条按主轴世界跨度等比,视口窗口实时映射。
	// v = 左侧竖条(条目高 = band);h = 底部横条(条目宽 = band)。
	const navGeo = useMemo(() => {
		const wrap = wrapRef.current;
		const railSize = horizontal ? (wrap?.clientWidth ?? 600) - 32 : (wrap?.clientHeight ?? 600) - 32;
		const band = Math.max(2, Math.min(6, railSize / Math.max(nodes.length, 1)));
		return { railSize, band };
	}, [nodes.length, horizontal]);
	const viewportBand = useMemo(() => {
		const wrap = wrapRef.current;
		if (!wrap) return null;
		const { railSize, band } = navGeo;
		const total = nodes.length * band;
		const off = Math.max(0, (railSize - total) / 2);
		if (horizontal) {
			const worldLeft = -view.x / view.scale;
			const worldRight = (wrap.clientWidth - view.x) / view.scale;
			const x1 = off + (worldLeft / width) * total;
			const x2 = off + (worldRight / width) * total;
			return { start: Math.max(0, x1), size: Math.min(railSize, Math.max(10, x2 - x1)) };
		}
		const worldTop = -view.y / view.scale;
		const worldBottom = (wrap.clientHeight - view.y) / view.scale;
		const y1 = off + (worldTop / height) * total;
		const y2 = off + (worldBottom / height) * total;
		return { start: Math.max(0, y1), size: Math.min(railSize, Math.max(10, y2 - y1)) };
	}, [view, navGeo, width, height, nodes.length, horizontal]);

	return (
		<div
			ref={wrapRef}
			className="tm-wrap"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onContextMenu={e => {
				e.preventDefault();
				setCtxMenu({ x: e.clientX, y: e.clientY, node: null });
			}}
			data-dragging={dragging || undefined}
		>
			{/* 顶栏:标题 + 轮数 + 搜索 + 时间轴 + 批量折叠/方向(玻璃容器)。 */}
			<div className="tm-topbar" onPointerDown={e => e.stopPropagation()}>
				<span className="tm-title">
					{t("turn map title")}
					<em className="tm-title-count">{tLoose("turn map turns count", { count: stats.turns })}</em>
					{loading === true && <em className="tm-title-loading">{t("turn map loading history")}</em>}
				</span>
				{turns.length > 0 && <TimelineOverview turns={turns} selection={range} onSelectionChange={setRange} />}
				<div className="tm-search" role="search">
					<Icon name="search" className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
					<input
						className="tm-search-input"
						type="text"
						placeholder={t("trajectory search placeholder")}
						value={searchQuery}
						onChange={e => setSearchQuery(e.target.value)}
					/>
				</div>
				<button
					type="button"
					className="tm-topbar-btn"
					title={t(anyExpanded ? "trajectory collapse all" : "trajectory expand all")}
					aria-label={t(anyExpanded ? "trajectory collapse all" : "trajectory expand all")}
					onClick={toggleAll}
				>
					<Icon name={anyExpanded ? "contract-up-down" : "expand-up-down"} className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-topbar-btn"
					title={t(horizontal ? "turn map layout vertical" : "turn map layout horizontal")}
					aria-label={t(horizontal ? "turn map layout vertical" : "turn map layout horizontal")}
					onClick={switchDirection}
				>
					<Icon name="layout-column" className="h-3 w-3" />
				</button>
			</div>
			{nodes.length === 0 ? (
				<p className="tm-empty">{t("trajectory empty")}</p>
			) : (
				<>
					{/* 迷你导航条:全轮次剪影 + 视口映射 + 点击/拖动跳转。 */}
					<div
						className="tm-nav"
						data-orient={direction}
						onPointerDown={e => e.stopPropagation()}
						onClick={e => {
							const rect = e.currentTarget.getBoundingClientRect();
							const { band } = navGeo;
							const along = horizontal ? e.clientX - rect.left : e.clientY - rect.top;
							const idx = Math.floor((along - Math.max(0, (navGeo.railSize - nodes.length * band) / 2)) / band);
							const clamped = Math.max(0, Math.min(nodes.length - 1, idx));
							const turn = nodes[clamped]?.group.turn;
							if (turn !== undefined) centerOnTurn(turn);
						}}
						title={t("trajectory turns")}
					>
						{nodes.map(n => (
							<span
								key={n.group.turn}
								className={`tm-nav-band tm-comp--${n.advisor ? "advisor" : (n.group.events[0]?.kind ?? "user")}`}
								style={horizontal ? { width: navGeo.band } : { height: navGeo.band }}
							/>
						))}
						{viewportBand && (
							<span
								className="tm-nav-viewport"
								style={
									horizontal
										? { left: viewportBand.start, width: viewportBand.size }
										: { top: viewportBand.start, height: viewportBand.size }
								}
							/>
						)}
					</div>
					<div
						className="tm-world"
						style={{
							width,
							height,
							transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
						}}
					>
						<svg className="tm-edges" width={width} height={height}>
							<defs>
								{/* userSpaceOnUse:垂直主线 <line> 的 objectBoundingBox
									宽度为 0,默认渐变坐标系下描边退化不可见(分支
									贝塞尔因有非零包围盒才正常)。 */}
								<linearGradient
									id="tm-main-line"
									gradientUnits="userSpaceOnUse"
									x1="0"
									y1="0"
									x2={horizontal ? width : 0}
									y2={horizontal ? 0 : height}
								>
									<stop offset="0%" className="tm-edge-gold-1" />
									<stop offset="100%" className="tm-edge-gold-2" />
								</linearGradient>
								<linearGradient
									id="tm-branch-line"
									gradientUnits="userSpaceOnUse"
									x1="0"
									y1="0"
									x2={horizontal ? 0 : width}
									y2={horizontal ? height : 0}
								>
									<stop offset="0%" className="tm-edge-gold-1" />
									<stop offset="100%" className="tm-edge-purple" />
								</linearGradient>
							</defs>
							{edges.map(e => {
								if (!e.branch) {
									// 主线直连(v:底部中心 → 下一节点顶部中心;h:右缘中心 →
									// 下一节点左缘中心;金色流动渐变)。
									const x1 = horizontal ? e.from.x + TURN_NODE_W : e.from.x + TURN_NODE_W / 2;
									const y1 = horizontal ? e.from.y + e.from.h / 2 : e.from.y + e.from.h;
									const x2 = horizontal ? e.to.x - 4 : e.to.x + TURN_NODE_W / 2;
									const y2 = horizontal ? e.to.y + e.to.h / 2 : e.to.y - 4;
									return (
										<line
											key={`m${e.from.group.turn}-${e.to.group.turn}`}
											className="tm-edge tm-edge--main"
											x1={x1}
											y1={y1}
											x2={x2}
											y2={y2}
										/>
									);
								}
								// 分支贝塞尔(v:源轮右缘中点 → 分支轮左缘中点;h:源轮底缘
								// 中点 → 分支轮顶缘中点;金→紫渐变)。
								const bx1 = horizontal ? e.from.x + TURN_NODE_W / 2 : e.from.x + TURN_NODE_W;
								const by1 = horizontal ? e.from.y + e.from.h : e.from.y + e.from.h / 2;
								const bx2 = horizontal ? e.to.x + TURN_NODE_W / 2 : e.to.x - 2;
								const by2 = horizontal ? e.to.y - 2 : e.to.y + e.to.h / 2;
								const mx = (bx1 + bx2) / 2;
								const my = (by1 + by2) / 2;
								const d = horizontal
									? `M ${bx1} ${by1} C ${bx1} ${my}, ${bx2} ${my}, ${bx2} ${by2}`
									: `M ${bx1} ${by1} C ${mx} ${by1}, ${mx} ${by2}, ${bx2} ${by2}`;
								return (
									<path
										key={`b${e.from.group.turn}-${e.to.group.turn}`}
										className="tm-edge tm-edge--branch"
										d={d}
									/>
								);
							})}
						</svg>
						{layout.lanes
							.filter(lane => visibleTurns.has(lane.first.group.turn))
							.map(lane => (
								<div
									key={`lane-${lane.lane}`}
									className="tm-lane-head"
									style={{ left: lane.first.x, top: Math.max(0, lane.first.y - 22) }}
								>
									{tLoose("turn map branch from", {
										turn:
											main.find(m => m.group.turn === lane.sourceTurn)?.group.displayTurn ?? lane.sourceTurn,
									})}
								</div>
							))}
						{visibleNodes.map(n => (
							<TmNodeCard
								key={n.group.turn}
								n={n}
								isLeaf={leafTurn === n.group.turn}
								isCurrent={currentTurn === n.group.turn}
								isExpanded={expanded.has(n.group.turn)}
								searchDim={hasSearch && searchMatchTurns !== null && !searchMatchTurns.has(n.group.turn)}
								searchHit={hasSearch && (searchMatchTurns?.has(n.group.turn) ?? false)}
								onToggle={handleClick}
								onJump={handleDblClick}
								onMenu={openNodeMenu}
								onHover={setHoverNode}
							/>
						))}
					</div>
				</>
			)}
			{/* 悬停浮卡:轮首消息全文 + 首末时刻。 */}
			{hoverNode && !dragging && (
				<div className="tm-hover" onPointerDown={e => e.stopPropagation()}>
					<div className="tm-hover-head">
						{hoverNode.group.turn === 0
							? t("trajectory system events")
							: `Turn ${hoverNode.group.displayTurn ?? hoverNode.group.turn}`}
						<span className="tm-hover-time">
							{hoverNode.group.firstTs
								? new Date(hoverNode.group.firstTs).toLocaleTimeString(undefined, timeFormatOptions())
								: "—"}{" "}
							→{" "}
							{hoverNode.group.endMs !== undefined
								? new Date(hoverNode.group.endMs).toLocaleTimeString(undefined, timeFormatOptions())
								: "—"}
						</span>
					</div>
					<div className="tm-hover-body">{turnSummaryOf(hoverNode.group)}</div>
				</div>
			)}
			{/* 右下缩放控件。 */}
			<div className="tm-zoom" onPointerDown={e => e.stopPropagation()}>
				<button
					type="button"
					className="tm-zoom-btn"
					title={t("locate current")}
					aria-label={t("locate current")}
					disabled={currentTurn === null}
					onClick={() => currentTurn !== null && centerOnTurn(currentTurn)}
				>
					<Icon name="target" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-zoom-btn"
					title={t("canvas zoom in")}
					aria-label={t("canvas zoom in")}
					onClick={() =>
						setView(v => {
							const scale = Math.min(MAX_SCALE, v.scale * 1.2);
							const k = scale / v.scale;
							const wrap = wrapRef.current;
							const cx = (wrap?.clientWidth ?? 0) / 2;
							const cy = (wrap?.clientHeight ?? 0) / 2;
							return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
						})
					}
				>
					<Icon name="add" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-zoom-btn"
					title={t("canvas reset view")}
					aria-label={t("canvas reset view")}
					onClick={() => {
						needsFitRef.current = true;
						fitView();
					}}
				>
					<Icon name="align-justify" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-zoom-btn"
					title={t("canvas zoom out")}
					aria-label={t("canvas zoom out")}
					onClick={() =>
						setView(v => {
							const scale = Math.max(MIN_SCALE, v.scale / 1.2);
							const k = scale / v.scale;
							const wrap = wrapRef.current;
							const cx = (wrap?.clientWidth ?? 0) / 2;
							const cy = (wrap?.clientHeight ?? 0) / 2;
							return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
						})
					}
				>
					<Icon name="subtract" className="h-3 w-3" />
				</button>
			</div>
			{ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} open onClose={() => setCtxMenu(null)} />}
		</div>
	);
}
