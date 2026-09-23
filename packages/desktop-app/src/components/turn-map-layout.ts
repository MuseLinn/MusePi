/**
 * 轮级会话地图布局(纯逻辑,无 DOM 依赖):把 buildTrajectoryTree 的
 * TrajectoryTurnGroup[164] 投影成画布节点 —— 主线一列垂直时间轴,
 * 重答/分叉轮横向开列,边 = 主线直连 + 分支贝塞尔。TurnMapCanvas 与
 * 单元测试共用。
 *
 * 设计稿:docs/review/0.5.0-map-redesign/design.md(投影单位从消息改为
 * 轮,164 轮 = 164 个节点,而不是 9985 张消息卡片)。
 */

import type { TrajectoryTurnGroup } from "./trajectory-data";

/** 轮节点卡尺寸(px)——设计稿 §3.1 NODE 208×88。 */
export const TURN_NODE_W = 208;
export const TURN_NODE_H = 88;
/** 列内节点垂直间距。 */
export const TURN_GAP_Y = 16;
/** 分支列相对主线的水平间距(分支卡宽 + 56)。 */
export const TURN_LANE_GAP = 56;

export interface TurnMapNode {
	group: TrajectoryTurnGroup;
	/** 0 = 主线;≥1 = 分支列(连续分支轮共用一列)。 */
	lane: number;
	x: number;
	y: number;
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
}

export interface TurnMapLayout {
	nodes: TurnMapNode[];
	edges: TurnMapEdge[];
	/** 主线轮(按序)。 */
	main: TurnMapNode[];
	/** 分支列头文案数据(列号 → 首个分支轮)。 */
	lanes: { lane: number; first: TurnMapNode; sourceTurn: number }[];
	width: number;
	height: number;
}

/** 轮内展开高度:事件行 24px × N + 底部留白 16(设计稿 §4)。 */
export function turnExpandedExtra(eventCount: number): number {
	return eventCount * 24 + 16;
}

/**
 * 布局:主线轮按序垂直堆叠(y 含展开增量),分支轮进入分支列(从分叉源
 * 的 y 开始向下堆叠);主线 x = 0,分支列 x = lane × (NODE_W + LANE_GAP)。
 * 分支判定 = 轮首事件带 branch 标记(buildTrajectory 的树判定),整轮
 * 归支线;连续分支轮共用一列。
 */
export function layoutTurnMap(
	turns: readonly TrajectoryTurnGroup[],
	expanded: ReadonlySet<number> = new Set(),
): TurnMapLayout {
	const nodes: TurnMapNode[] = [];
	const main: TurnMapNode[] = [];
	// 轮前元事件(model_change / 会话开始等,turn = 0 且没有 user 事件)
	// 不构成一轮,地图不为其发节点(轨迹视图仍保留该组)。
	const rounds = turns.filter(g => g.turn > 0 || g.events.some(e => e.kind === "user"));
	// 分支列分配:连续分支轮同列;遇主线轮重置。lane 序号按出现顺序递增。
	let lane = 0;
	let lastWasBranch = false;
	let mainY = 0;
	// 每列的当前 y(分支列从分叉源 y 起排)。
	const laneY = new Map<number, number>();
	const laneSource = new Map<number, number>();
	const edges: TurnMapEdge[] = [];

	for (const group of rounds) {
		const branch = group.events[0]?.branch === true;
		const advisor = group.events[0]?.kind === "advisor";
		const extra = expanded.has(group.turn) ? turnExpandedExtra(group.events.length) : 0;
		let node: TurnMapNode;
		if (!branch) {
			node = {
				group,
				lane: 0,
				x: 0,
				y: mainY,
				branch: false,
				sourceTurn: null,
				advisor,
				expandedExtra: extra,
			};
			mainY += TURN_NODE_H + extra + TURN_GAP_Y;
			main.push(node);
			lastWasBranch = false;
		} else {
			if (!lastWasBranch) lane += 1;
			lastWasBranch = true;
			// 分叉源 = 上一个主线轮。
			const source = main[main.length - 1];
			const sourceTurn = source?.group.turn ?? 0;
			if (!laneSource.has(lane)) laneSource.set(lane, sourceTurn);
			const y = Math.max(laneY.get(lane) ?? 0, (source?.y ?? 0) + TURN_NODE_H + TURN_GAP_Y);
			node = {
				group,
				lane,
				x: lane * (TURN_NODE_W + TURN_LANE_GAP),
				y,
				branch: true,
				sourceTurn,
				advisor,
				expandedExtra: extra,
			};
			laneY.set(lane, y + TURN_NODE_H + extra + TURN_GAP_Y);
		}
		nodes.push(node);
	}
	// 主线直连边。
	for (let i = 0; i + 1 < main.length; i++) edges.push({ from: main[i]!, to: main[i + 1]!, branch: false });
	// 分支边:源轮 → 分支轮(贝塞尔由渲染层画)。
	for (const n of nodes) {
		if (!n.branch) continue;
		const source = main.find(m => m.group.turn === n.sourceTurn);
		if (source) edges.push({ from: source, to: n, branch: true });
	}
	const lanes = [...laneSource.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([laneNo, sourceTurn]) => ({
			lane: laneNo,
			first: nodes.find(n => n.lane === laneNo) as TurnMapNode,
			sourceTurn,
		}));
	const laneCount = Math.max(1, lane + 1);
	const width = laneCount * TURN_NODE_W + (laneCount - 1) * TURN_LANE_GAP;
	const height = Math.max(mainY, ...nodes.map(n => n.y + TURN_NODE_H + n.expandedExtra + TURN_GAP_Y), TURN_NODE_H * 2);
	return { nodes, edges, main, lanes, width, height };
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
 * 十几张;filter O(n) 每帧一次可忽略。展开轮高度含 expandedExtra。
 * 纯逻辑,组件与测试共用。
 */
export function visibleTurnMapNodes(nodes: readonly TurnMapNode[], vp: TurnMapViewport, pad = 260): TurnMapNode[] {
	return nodes.filter(
		n =>
			n.x + TURN_NODE_W >= vp.left - pad &&
			n.x <= vp.right + pad &&
			n.y + TURN_NODE_H + n.expandedExtra >= vp.top - pad &&
			n.y <= vp.bottom + pad,
	);
}
