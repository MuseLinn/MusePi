/**
 * 轮级会话地图布局(纯逻辑,无 DOM 依赖):把 buildTrajectoryTree 的
 * TrajectoryTurnGroup[164] 投影成画布节点 —— 主线一条时间轴,重答/分叉
 * 轮开列分支,边 = 主线直连 + 分支贝塞尔;分叉在父轮结束后的干线上形成
 * 独立交汇点(git 树式圆点),兄弟分支共享。TurnMapCanvas 与单元测试共用。
 *
 * 方向(direction):"v" = 主线垂直、分支横向开列(默认);"h" = 主线水平、
 * 分支纵向开行。两个方向的几何互为转置(轴交换),裁剪/导航共用同一套
 * 世界坐标。
 *
 * 设计稿:docs/review/0.5.0-map-redesign/design.md(投影单位从消息改为
 * 轮,164 轮 = 164 个节点,而不是 9985 张消息卡片);2026-10-01 实机诉求:
 * 每轮 = 可折叠框(展开 = 框内事件卡),分叉 = 父轮末端干线上的交汇点。
 */

import type { TrajectoryEvent, TrajectoryTurnGroup } from "./trajectory-data";

/** 轮节点卡尺寸(px)——设计稿 §3.1 NODE 208×88。 */
export const TURN_NODE_W = 208;
export const TURN_NODE_H = 88;
/** 折叠态紧凑卡高度:单行(徽章 + 摘要 + 计数 + 用时)。 */
export const TURN_NODE_COMPACT_H = 40;
/** 主线相邻节点间距(v = 垂直,h = 水平)。 */
export const TURN_GAP_Y = 16;
/** 分支车道相对主线的间距(v = 水平列距,h = 垂直行距)。 */
export const TURN_LANE_GAP = 56;

/** 地图方向:"v" = 主线垂直(默认),"h" = 主线水平。 */
export type TurnMapDirection = "v" | "h";

export interface TurnMapNode {
	group: TrajectoryTurnGroup;
	/** 0 = 主线;≥1 = 分支车道(连续分支轮共用车道)。 */
	lane: number;
	x: number;
	y: number;
	/** 当前有效高度(折叠 = 紧凑卡高;展开 = 基础卡高 + 泳道增量)。 */
	h: number;
	/** 分支轮(lane ≥ 1)。 */
	branch: boolean;
	/** 分支轮的分叉来源主线轮号(主线轮为 null)。 */
	sourceTurn: number | null;
	/** 该轮是否顾问轮(events[0].kind === "advisor",徽章薄荷青)。 */
	advisor: boolean;
	/** 轮内展开后的增量高度(px;展开高度 = TURN_NODE_H + expandedExtra)。 */
	expandedExtra: number;
}

export interface TurnMapEdge {
	/** 主线直连(main[i] → main[i+1])或分支贝塞尔(source → branch)。 */
	from: TurnMapNode;
	to: TurnMapNode;
	branch: boolean;
	/** 分支边:交汇点世界坐标(渲染层从交汇点而非源轮卡片发线)。 */
	junction?: { x: number; y: number };
}

export interface TurnMapLayout {
	nodes: TurnMapNode[];
	edges: TurnMapEdge[];
	/** 主线轮(按序)。 */
	main: TurnMapNode[];
	/** 分支车道头文案数据(车道号 → 首个分支轮)。 */
	lanes: { lane: number; first: TurnMapNode; sourceTurn: number }[];
	/** 干线交汇点(兄弟分支按 sourceTurn 去重)。 */
	junctions: TurnMapJunction[];
	width: number;
	height: number;
}

/** 轮内泳道可视上限(px):事件卡超过即轮内滚动,卡片不再长高
 *  (与 CSS .tm-lane max-height 同步,实机回归:Turn 6 事件多,展开卡
 *  按事件数撑到数千 px 高而内容只有顶部一截)。 */
export const TURN_LANE_MAX_H = 240;
/** 单行事件卡高(px)——与 CSS .tm-lane-row(主行 only)同步。 */
export const TURN_EVENT_CARD_H = 28;
/** 双行事件卡高(px)——工具行(名称主行 + 参数摘要副行);与 CSS 同步。 */
export const TURN_EVENT_CARD_DETAIL_H = 44;
/** 轮内事件卡间距(px)——与 CSS .tm-lane gap 同步。 */
export const TURN_EVENT_CARD_GAP = 4;
/** 泳道容器上下留白合计(px)——与 CSS .tm-lane padding 同步。 */
export const TURN_LANE_PAD = 8;

/** 事件卡高计算的最小输入(布局层不依赖完整 TrajectoryEvent)。 */
interface TurnEventCardShape {
	kind: TrajectoryEvent["kind"];
	body?: string;
}

/**
 * 单张事件卡高度:工具事件带参数摘要 = 双行卡(44px),其余单行(28px)。
 *  卡片形态与 TurnMapCanvas 的渲染分支(tm-lane-detail 是否存在)同源,
 *  布局增量按真实渲染高度计,展开卡不再截断或留白。
 */
export function turnEventCardH(ev: TurnEventCardShape): number {
	return ev.kind === "tool" && ev.body ? TURN_EVENT_CARD_DETAIL_H : TURN_EVENT_CARD_H;
}

/**
 * 轮内展开高度:Σ 各事件卡高(单/双行) + 间距 4px × (N-1) + 泳道留白 8,
 *  封顶 TURN_LANE_MAX_H + 8(泳道滚动,高度与可视内容一致)。
 */
export function turnExpandedExtra(events: readonly TurnEventCardShape[]): number {
	const cardsH = events.reduce((acc, ev) => acc + turnEventCardH(ev), 0);
	const gapsH = Math.max(0, events.length - 1) * TURN_EVENT_CARD_GAP;
	return Math.min(cardsH + gapsH + TURN_LANE_PAD, TURN_LANE_MAX_H + TURN_LANE_PAD);
}

/**
 * 干线交汇点(git 树式分叉节点):分支不从父轮卡片中部拉线,而是在
 * 父轮结束之后的主干线上形成一个独立圆点,兄弟分支轮都从这个点
 * 发出(实机设计诉求 2026-10-01:分叉 = 从上一个轮的末端开始,不是
 * 从轮的内部)。同一父轮的多个兄弟分支共享一个交汇点。
 */
export interface TurnMapJunction {
	/** 交汇点世界坐标:v = 主线卡水平中心 × 父轮下缘间距中点;
	 *  h = 父轮右缘间距中点 × 父轮垂直中心(正好落在干线连线上)。 */
	x: number;
	y: number;
	/** 分叉源主线轮号(兄弟分支共享同一交汇点)。 */
	sourceTurn: number;
}

/**
 * 布局:主线轮沿主轴按序堆叠(坐标含展开增量),分支轮进入分支车道
 * (从分叉源的坐标起排);主线 v 模式 x=0 / h 模式 y=0,分支车道 v 模式
 * x = lane × (NODE_W + LANE_GAP) / h 模式 y = lane × (NODE_H + LANE_GAP)。
 * 分支判定 = 轮首事件带 branch 标记(buildTrajectory 的树判定),整轮
 * 归支线;连续分支轮共用车道。
 */
export function layoutTurnMap(
	turns: readonly TrajectoryTurnGroup[],
	expanded: ReadonlySet<number> = new Set(),
	direction: TurnMapDirection = "v",
): TurnMapLayout {
	const horizontal = direction === "h";
	const nodes: TurnMapNode[] = [];
	const main: TurnMapNode[] = [];
	// 轮前元事件(model_change / 会话开始等,turn = 0 且没有 user 事件)
	// 不构成一轮,地图不为其发节点(轨迹视图仍保留该组)。
	const rounds = turns.filter(g => g.turn > 0 || g.events.some(e => e.kind === "user"));
	// 分支车道分配:连续分支轮同车道;遇主线轮重置。lane 序号按出现顺序递增。
	let lane = 0;
	let lastWasBranch = false;
	// 主线游标:v = 下一主线轮的 y;h = 下一主线轮的 x。
	let mainPos = 0;
	// 每车道的当前游标(分支轮从分叉源坐标起排)。
	const lanePos = new Map<number, number>();
	const laneSource = new Map<number, number>();
	// h 模式车道行:行顶 y(同行节点共享)与行底水位(新行不得压上一行)。
	const laneRowY = new Map<number, number>();
	let laneRowBottom = 0;
	const edges: TurnMapEdge[] = [];

	for (const group of rounds) {
		const branch = group.events[0]?.branch === true;
		const advisor = group.events[0]?.kind === "advisor";
		const extra = expanded.has(group.turn) ? turnExpandedExtra(group.events) : 0;
		const h = extra > 0 ? TURN_NODE_H + extra : TURN_NODE_COMPACT_H;
		// 主线 advance 步长:v = 卡高 + 展开增量 + 间距(展开占纵向);
		// h = 卡宽 + 间距(展开增量向卡下方生长,不占横向)。
		const step = horizontal ? TURN_NODE_W + TURN_GAP_Y : TURN_NODE_H + extra + TURN_GAP_Y;
		let node: TurnMapNode;
		if (!branch) {
			node = {
				group,
				lane: 0,
				x: horizontal ? mainPos : 0,
				y: horizontal ? 0 : mainPos,
				h,
				branch: false,
				sourceTurn: null,
				advisor,
				expandedExtra: extra,
			};
			mainPos += step;
			main.push(node);
			lastWasBranch = false;
		} else {
			if (!lastWasBranch) lane += 1;
			lastWasBranch = true;
			// 分叉源 = 树上深度-1 的主线轮(兄弟轮共享同一父轮:撤回/重答
			// 的新轮挂在上一轮末尾,与旧轮是兄弟,不是旧轮的子轮)。深度
			// 缺失(链断回退 journal 序)时回退旧行为"上一个主线轮"。实机
			// 回归 2026-10-01:旧规则按 journal 顺序取"上一个主线轮",把
			// 兄弟轮画成旧轮的子节点(分叉锚点错位一整轮)。
			const branchDepth = group.events[0]?.pathTurn;
			const source =
				(branchDepth !== undefined && branchDepth > 1
					? main.find(m => (m.group.displayTurn ?? m.group.turn) === branchDepth - 1)
					: undefined) ?? main[main.length - 1];
			const sourceTurn = source?.group.turn ?? 0;
			if (!laneSource.has(lane)) laneSource.set(lane, sourceTurn);
			if (horizontal) {
				// 车道行 y:新行 = 车道序基准与前一行底部(含展开)取大;同行
				// 节点共享行顶。行内从分叉源右缘起向右排。
				let y = laneRowY.get(lane);
				if (y === undefined) {
					y = Math.max(lane * (TURN_NODE_H + TURN_LANE_GAP), laneRowBottom);
					laneRowY.set(lane, y);
				}
				const x = Math.max(lanePos.get(lane) ?? 0, (source?.x ?? 0) + TURN_NODE_W + TURN_GAP_Y);
				node = {
					group,
					lane,
					x,
					y,
					h,
					branch: true,
					sourceTurn,
					advisor,
					expandedExtra: extra,
				};
				lanePos.set(lane, x + TURN_NODE_W + TURN_GAP_Y);
				laneRowBottom = Math.max(laneRowBottom, y + h + TURN_GAP_Y);
			} else {
				// 车道列 x 固定按车道序;列内从分叉源下缘起向下排。
				const x = lane * (TURN_NODE_W + TURN_LANE_GAP);
				const y = Math.max(lanePos.get(lane) ?? 0, (source?.y ?? 0) + TURN_NODE_H + TURN_GAP_Y);
				node = {
					group,
					lane,
					x,
					y,
					h,
					branch: true,
					sourceTurn,
					advisor,
					expandedExtra: extra,
				};
				lanePos.set(lane, y + TURN_NODE_H + extra + TURN_GAP_Y);
			}
		}
		nodes.push(node);
	}
	// 主线直连边。
	for (let i = 0; i + 1 < main.length; i++) edges.push({ from: main[i]!, to: main[i + 1]!, branch: false });
	// 分支边:源轮 → 分支轮(贝塞尔由渲染层画);交汇点落在父轮结束之后
	// 的干线间距中点(v:主线卡中心 × 父轮下缘+GAP/2;h:父轮右缘+GAP/2 ×
	// 父轮垂直中心),兄弟分支按 sourceTurn 共享一个交汇点。
	const junctions: TurnMapJunction[] = [];
	const junctionBySource = new Map<number, TurnMapJunction>();
	for (const n of nodes) {
		if (!n.branch) continue;
		const source = main.find(m => m.group.turn === n.sourceTurn);
		if (!source) continue;
		const jx = horizontal ? source.x + TURN_NODE_W + TURN_GAP_Y / 2 : source.x + TURN_NODE_W / 2;
		const jy = horizontal ? source.y + source.h / 2 : source.y + source.h + TURN_GAP_Y / 2;
		let junction = junctionBySource.get(source.group.turn);
		if (!junction) {
			junction = { x: jx, y: jy, sourceTurn: source.group.turn };
			junctionBySource.set(source.group.turn, junction);
			junctions.push(junction);
		}
		edges.push({ from: source, to: n, branch: true, junction: { x: junction.x, y: junction.y } });
	}
	const lanes = [...laneSource.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([laneNo, sourceTurn]) => ({
			lane: laneNo,
			first: nodes.find(n => n.lane === laneNo) as TurnMapNode,
			sourceTurn,
		}));
	const laneCount = Math.max(1, lane + 1);
	// 车道跨度(横向开列的总宽 / 纵向开行的总高)与主线跨度。
	const laneSpan = laneCount * TURN_NODE_W + (laneCount - 1) * TURN_LANE_GAP;
	const laneSpanH = laneCount * TURN_NODE_H + (laneCount - 1) * TURN_LANE_GAP;
	const chainSpan = Math.max(mainPos - TURN_GAP_Y, ...nodes.map(n => n.y + n.h + TURN_GAP_Y), TURN_NODE_H * 2);
	const chainSpanW = Math.max(
		mainPos - TURN_GAP_Y,
		...nodes.map(n => n.x + TURN_NODE_W + TURN_GAP_Y),
		TURN_NODE_W * 2,
	);
	const width = horizontal ? chainSpanW : laneSpan;
	const height = horizontal ? Math.max(laneSpanH, laneRowBottom, TURN_NODE_H * 2) : chainSpan;
	return { nodes, edges, main, lanes, junctions, width, height };
}

/** 视口裁剪矩形(世界坐标)。 */
export interface TurnMapViewport {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * 视口裁剪:只保留与可见世界矩形相交(外扩 pad)的节点——画布版的
 * 「渐进挂载」。164 轮全量节点卡 ≈ 1600+ DOM,而任何时刻视口内只有
 * 十几张;filter O(n) 每帧一次可忽略。节点高 = 折叠紧凑卡或展开全卡,
 * 用 node.h 命中判定。纯逻辑,组件与测试共用。
 */
export function visibleTurnMapNodes(nodes: readonly TurnMapNode[], vp: TurnMapViewport, pad = 260): TurnMapNode[] {
	return nodes.filter(
		n =>
			n.x + TURN_NODE_W >= vp.left - pad &&
			n.x <= vp.right + pad &&
			n.y + n.h >= vp.top - pad &&
			n.y <= vp.bottom + pad,
	);
}
