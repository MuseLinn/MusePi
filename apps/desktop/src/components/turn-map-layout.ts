/**
 * 轮级会话地图布局(纯逻辑,无 DOM 依赖)。
 *
 * 投影单位 = 轮:主线一条时间轴,分支轮进入自己的车道列。卡片尺寸固定
 * (索引行,不随内容长高),边 = 正交折线 + 箭头,分叉 = 干线交汇点上的一次
 * 分裂。TurnMapCanvas 与单元测试共用同一份几何。
 *
 * 三条几何契约(对应 docs/gui-design.md § 会话地图信息模型):
 *
 *  1. **方向可见**:每条边的折线从父轮出发、在子轮处收尾,并带一个箭头
 *     (`TurnMapEdge.arrow`)。箭头不是装饰——曲线连线说不出「谁生了谁」,
 *     正交折线 + 箭头才说得出来。
 *
 *  2. **分叉是一处分裂,不是一团交叉**:同一父轮的兄弟分支**各占一条车道**
 *     (同车道只留给嵌套分支:分支的父轮本身也是分支、且是紧邻的上一条)。
 *     同一车道的兄弟会让第二条边从第一张卡身上穿过去,那正是用户说的
 *     「乱连的曲线」。分裂点落在父轮之后的干线交汇圆点上,所有兄弟共享
 *     同一个圆点,然后各自横出到自己的车道再垂直落进卡顶。
 *
 *  3. **卡片高度固定**:轮内事件不再长在卡里(那是检视器的活),所以布局
 *     没有展开增量,后续节点也不会被推开。地图是索引,不是预览。
 */

import { turnIsOffPath } from "../lib/turn-map-facts";
import type { TrajectoryTurnGroup } from "./trajectory-data";

/** 轮节点卡尺寸(px):固定高度索引行。 */
export const TURN_NODE_W = 208;
export const TURN_NODE_H = 66;
/** 主线相邻节点间距(v = 纵向,h = 横向)。留出箭头与折线的落点。 */
export const TURN_GAP_Y = 20;
/** 分支车道相对主线的间距(v = 列距,h = 行距)。 */
export const TURN_LANE_GAP = 56;

/** 交汇点向下(纵向)/向右(横向)伸出的一小段干线残端,折线从这里拐弯。 */
export const TURN_BRANCH_STEM = 6;
/**
 * 分支车道起点相对「父轮下缘 + 间距」的额外让位:保证折线在落进分支卡之前
 * 有一段可见的垂直(横向模式下为水平)行程,而不是贴着卡边拐弯。
 */
export const TURN_BRANCH_LANE_OFFSET = 18;

/** 箭头长度与半宽(px):画在子轮一侧,指向子轮。 */
export const TURN_ARROW_LEN = 7;
export const TURN_ARROW_HALF = 3.5;

/** 地图方向:"v" = 主线垂直(默认),"h" = 主线水平。 */
export type TurnMapDirection = "v" | "h";

export interface TurnMapPoint {
	x: number;
	y: number;
}

export interface TurnMapNode {
	group: TrajectoryTurnGroup;
	/** 0 = 主线;≥1 = 分支车道。 */
	lane: number;
	x: number;
	y: number;
	/** 卡片高度(恒为 TURN_NODE_H;保留字段以免调用方改读常量)。 */
	h: number;
	/** 分支轮(lane ≥ 1)。 */
	branch: boolean;
	/** 分支轮的分叉来源主线轮号(主线轮为 null)。 */
	sourceTurn: number | null;
	/** 该轮是否顾问轮(events[0].kind === "advisor",徽章薄荷青)。 */
	advisor: boolean;
	/** 该轮是否在活跃路径之外(撤回落下的旁支)。路径未知时为 false。 */
	offPath: boolean;
}

export interface TurnMapEdge {
	from: TurnMapNode;
	to: TurnMapNode;
	branch: boolean;
	/** 正交折线(世界坐标),父端 → 子端。 */
	points: TurnMapPoint[];
	/** 箭头:尖端落在子轮边缘,dx/dy 为单位方向(指向子轮内部)。 */
	arrow: { x: number; y: number; dx: number; dy: number };
	/** 分支边:干线交汇点(渲染层画圆点,兄弟共享)。 */
	junction?: TurnMapPoint;
	/** 子轮离路径:边随之淡出(仍在,不消失)。 */
	offPath: boolean;
}

/**
 * 一处分叉:同一父轮发出的所有兄弟分支共享的干线交汇点。
 *
 * 标签挂在分叉处而不是每条车道头上——兄弟各占一列后,「自 Turn N」在每列
 * 重复一遍既占地方又不说更多;分裂点上写一次「自 Turn N · 2 支」就够。
 */
interface TurnMapSplit {
	/** 分叉来源主线轮节点。 */
	source: TurnMapNode;
	/** 来源轮展示编号(兄弟序标签 → 树深度 → 轮号)。 */
	sourceLabel: string | number;
	/** 交汇点世界坐标(正落在干线上)。 */
	x: number;
	y: number;
	/** 该分叉发出的分支轮数。 */
	count: number;
}

export interface TurnMapLayout {
	nodes: TurnMapNode[];
	edges: TurnMapEdge[];
	/** 主线轮(按序)。 */
	main: TurnMapNode[];
	/** 干线分叉点(按出现顺序)。 */
	splits: TurnMapSplit[];
	width: number;
	height: number;
}

/** 轮的展示编号:同父兄弟序标签(如 "2-1")→ 树深度 → journal 序。 */
export function turnDisplayLabel(group: TrajectoryTurnGroup): string | number {
	return group.displayTurnLabel ?? group.displayTurn ?? group.turn;
}

export interface TurnMapLayoutOptions {
	direction?: TurnMapDirection;
	/** 对话在视条目 id 集(见 lib/turn-map-path);给了就以它判定离路径。 */
	pathIds?: ReadonlySet<string>;
}

/**
 * 布局:主线轮沿主轴按序堆叠,分支轮进入车道(列 / 行)。
 *
 * 车道分配:嵌套分支(父轮就是紧邻的上一条分支轮)留在父轮的车道里向下排;
 * 其余每个分支轮各开一条新车道。兄弟共享一条车道会让后一条边从先一张卡
 * 身上穿过——分叉于是读成打结,而不是分裂。
 */
export function layoutTurnMap(
	turns: readonly TrajectoryTurnGroup[],
	options: TurnMapLayoutOptions = {},
): TurnMapLayout {
	const horizontal = options.direction === "h";
	const pathIds = options.pathIds;
	const nodes: TurnMapNode[] = [];
	const main: TurnMapNode[] = [];
	// 轮前元事件(model_change / 会话开始等,turn = 0 且没有 user 事件)
	// 不构成一轮,地图不为其发节点(轨迹视图仍保留该组)。
	const rounds = turns.filter(g => g.turn > 0 || g.events.some(e => e.kind === "user"));
	let laneCount = 0;
	/** 紧邻的上一条分支轮(判定嵌套续车道用);遇主线轮清空。 */
	let prevBranch: TurnMapNode | null = null;
	// 主线游标:v = 下一主线轮的 y;h = 下一主线轮的 x。
	let mainPos = 0;
	// 每车道的当前游标(分支轮从分叉源之后起排)。
	const lanePos = new Map<number, number>();
	// h 模式车道行:行顶 y(同行节点共享)与行底水位(新行不得压上一行)。
	const laneRowY = new Map<number, number>();
	let laneRowBottom = 0;
	// 分支轮 → 解析出的来源轮节点(交汇点与边共用,避免按可重复轮号回查)。
	const branchSourceOf = new Map<TurnMapNode, TurnMapNode>();

	for (const group of rounds) {
		const branch = group.events[0]?.branch === true;
		const advisor = group.events[0]?.kind === "advisor";
		const offPath = turnIsOffPath(group, pathIds);
		const h = TURN_NODE_H;
		const step = horizontal ? TURN_NODE_W + TURN_GAP_Y : TURN_NODE_H + TURN_GAP_Y;
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
				offPath,
			};
			mainPos += step;
			main.push(node);
			prevBranch = null;
		} else {
			// 优先使用派生层记录的真实父轮,父轮自身在支线时也不会错接。
			// 旧快照没有 parentId 时才按深度回退到主线,再退回最近主线轮。
			const branchDepth = group.events[0]?.pathTurn;
			const source =
				(group.parentId !== undefined ? nodes.find(n => n.group.id === group.parentId) : undefined) ??
				(branchDepth !== undefined && branchDepth > 1
					? main.find(m => (m.group.displayTurn ?? m.group.turn) === branchDepth - 1)
					: undefined) ??
				main[main.length - 1];
			const sourceTurn = source?.group.turn ?? 0;
			// 嵌套续车道:父轮就是紧邻的上一条分支轮 → 同车道向下排,
			// 边是车道内的一条直线,不会跨过别的卡。
			const continueLane = prevBranch !== null && source === prevBranch;
			if (!continueLane) laneCount += 1;
			const lane = continueLane && prevBranch ? prevBranch.lane : laneCount;
			if (horizontal) {
				let y = laneRowY.get(lane);
				if (y === undefined) {
					y = Math.max(lane * (TURN_NODE_H + TURN_LANE_GAP), laneRowBottom);
					laneRowY.set(lane, y);
				}
				const x = Math.max(
					lanePos.get(lane) ?? 0,
					(source?.x ?? 0) + TURN_NODE_W + TURN_GAP_Y + TURN_BRANCH_LANE_OFFSET,
				);
				node = { group, lane, x, y, h, branch: true, sourceTurn, advisor, offPath };
				lanePos.set(lane, x + TURN_NODE_W + TURN_GAP_Y);
				laneRowBottom = Math.max(laneRowBottom, y + h + TURN_GAP_Y);
			} else {
				const x = lane * (TURN_NODE_W + TURN_LANE_GAP);
				const y = Math.max(
					lanePos.get(lane) ?? 0,
					(source?.y ?? 0) + (source?.h ?? TURN_NODE_H) + TURN_GAP_Y + TURN_BRANCH_LANE_OFFSET,
				);
				node = { group, lane, x, y, h, branch: true, sourceTurn, advisor, offPath };
				lanePos.set(lane, y + TURN_NODE_H + TURN_GAP_Y);
			}
			if (source) branchSourceOf.set(node, source);
			prevBranch = node;
		}
		nodes.push(node);
	}

	const edges: TurnMapEdge[] = [];
	// 主线直连:两卡中心对中心,正交(同一 x / 同一 y),箭头落在子轮边缘。
	for (let i = 0; i + 1 < main.length; i++) {
		edges.push(mainEdge(main[i]!, main[i + 1]!, horizontal));
	}
	// 分支边:源轮 → 分支轮。交汇点落在父轮之后的干线间距中点,兄弟共享。
	const splitBySource = new Map<TurnMapNode, TurnMapSplit>();
	const splits: TurnMapSplit[] = [];
	for (const n of nodes) {
		if (!n.branch) continue;
		const source = branchSourceOf.get(n);
		if (!source) continue;
		const jx = horizontal ? source.x + TURN_NODE_W + TURN_GAP_Y / 2 : source.x + TURN_NODE_W / 2;
		const jy = horizontal ? source.y + source.h / 2 : source.y + source.h + TURN_GAP_Y / 2;
		let split = splitBySource.get(source);
		if (!split) {
			split = {
				source,
				sourceLabel: turnDisplayLabel(source.group),
				x: jx,
				y: jy,
				count: 0,
			};
			splitBySource.set(source, split);
			splits.push(split);
		}
		split.count += 1;
		edges.push(branchEdge(source, n, { x: jx, y: jy }, horizontal));
	}

	const laneCountUsed = Math.max(1, laneCount + 1);
	const laneSpan = laneCountUsed * TURN_NODE_W + (laneCountUsed - 1) * TURN_LANE_GAP;
	const laneSpanH = laneCountUsed * TURN_NODE_H + (laneCountUsed - 1) * TURN_LANE_GAP;
	const chainSpan = Math.max(mainPos - TURN_GAP_Y, ...nodes.map(n => n.y + n.h + TURN_GAP_Y), TURN_NODE_H * 2);
	const chainSpanW = Math.max(
		mainPos - TURN_GAP_Y,
		...nodes.map(n => n.x + TURN_NODE_W + TURN_GAP_Y),
		TURN_NODE_W * 2,
	);
	const width = horizontal ? chainSpanW : laneSpan;
	const height = horizontal ? Math.max(laneSpanH, laneRowBottom, TURN_NODE_H * 2) : chainSpan;
	return { nodes, edges, main, splits, width, height };
}

/** 主线边:同轴直线,箭头贴着子轮。 */
function mainEdge(from: TurnMapNode, to: TurnMapNode, horizontal: boolean): TurnMapEdge {
	if (horizontal) {
		const y = from.y + from.h / 2;
		const start = { x: from.x + TURN_NODE_W, y };
		const end = { x: to.x, y };
		return {
			from,
			to,
			branch: false,
			points: [start, end],
			arrow: { x: end.x - 1, y, dx: 1, dy: 0 },
			offPath: to.offPath,
		};
	}
	const x = from.x + TURN_NODE_W / 2;
	const start = { x, y: from.y + from.h };
	const end = { x, y: to.y };
	return {
		from,
		to,
		branch: false,
		points: [start, end],
		arrow: { x, y: end.y - 1, dx: 0, dy: 1 },
		offPath: to.offPath,
	};
}

/**
 * 分支边:交汇点 → 干线残端 → 车道 → 子轮。
 *
 * 落点是子轮「朝向父轮的那条边」的中点:纵向 = 卡顶中心,横向 = 卡左缘中心。
 * 同一父轮的兄弟共享交汇点与残端,从残端末梢横出到各自车道——这一步就是
 * 可见的「分裂」。嵌套分支(父轮与子轮同车道)退化为一条直线。
 */
function branchEdge(from: TurnMapNode, to: TurnMapNode, junction: TurnMapPoint, horizontal: boolean): TurnMapEdge {
	if (horizontal) {
		const by = to.y + to.h / 2;
		const stemX = junction.x + TURN_BRANCH_STEM;
		const points: TurnMapPoint[] =
			Math.abs(by - junction.y) < 1
				? [junction, { x: to.x, y: by }]
				: [junction, { x: stemX, y: junction.y }, { x: stemX, y: by }, { x: to.x, y: by }];
		return {
			from,
			to,
			branch: true,
			points,
			arrow: { x: to.x - 1, y: by, dx: 1, dy: 0 },
			junction,
			offPath: to.offPath,
		};
	}
	const bx = to.x + TURN_NODE_W / 2;
	const stemY = junction.y + TURN_BRANCH_STEM;
	const points: TurnMapPoint[] =
		Math.abs(bx - junction.x) < 1
			? [junction, { x: bx, y: to.y }]
			: [junction, { x: junction.x, y: stemY }, { x: bx, y: stemY }, { x: bx, y: to.y }];
	return {
		from,
		to,
		branch: true,
		points,
		arrow: { x: bx, y: to.y - 1, dx: 0, dy: 1 },
		junction,
		offPath: to.offPath,
	};
}

/** 折线的 SVG path(d):折点处留 4px 圆角,方向与落点不变。 */
export function edgePathD(points: readonly TurnMapPoint[], radius = 4): string {
	if (points.length === 0) return "";
	const first = points[0]!;
	if (points.length === 1) return `M ${first.x} ${first.y}`;
	let d = `M ${first.x} ${first.y}`;
	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1]!;
		const cur = points[i]!;
		const next = points[i + 1];
		if (!next) {
			d += ` L ${cur.x} ${cur.y}`;
			continue;
		}
		// 入段方向与出段方向的单位向量;折点处各退 radius。
		const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
		const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
		const r = Math.min(radius, inLen / 2, outLen / 2);
		if (r <= 0.01) {
			d += ` L ${cur.x} ${cur.y}`;
			continue;
		}
		const inX = cur.x - ((cur.x - prev.x) / inLen) * r;
		const inY = cur.y - ((cur.y - prev.y) / inLen) * r;
		const outX = cur.x + ((next.x - cur.x) / outLen) * r;
		const outY = cur.y + ((next.y - cur.y) / outLen) * r;
		d += ` L ${inX} ${inY} Q ${cur.x} ${cur.y} ${outX} ${outY}`;
	}
	return d;
}

/** 箭头三角形的三个顶点(尖端 + 两翼),由 TurnMapEdge.arrow 展开。 */
export function arrowTriangle(arrow: TurnMapEdge["arrow"]): [TurnMapPoint, TurnMapPoint, TurnMapPoint] {
	const tip = { x: arrow.x, y: arrow.y };
	// 垂直于方向的两个翼。
	const nx = -arrow.dy;
	const ny = arrow.dx;
	const backX = tip.x - arrow.dx * TURN_ARROW_LEN;
	const backY = tip.y - arrow.dy * TURN_ARROW_LEN;
	return [
		tip,
		{ x: backX + nx * TURN_ARROW_HALF, y: backY + ny * TURN_ARROW_HALF },
		{ x: backX - nx * TURN_ARROW_HALF, y: backY - ny * TURN_ARROW_HALF },
	];
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
 * 十几张;filter O(n) 每帧一次可忽略。
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
