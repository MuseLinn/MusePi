import { describe, expect, it } from "bun:test";
import type { TrajectoryEvent, TrajectoryTurnGroup } from "../src/components/trajectory-data";
import {
	layoutTurnMap,
	TURN_GAP_Y,
	TURN_LANE_GAP,
	TURN_NODE_COMPACT_H,
	TURN_NODE_H,
	TURN_NODE_W,
	type TurnMapNode,
	turnExpandedExtra,
	visibleTurnMapNodes,
} from "../src/components/turn-map-layout";

// 轮级会话地图布局(0.5.0-map-redesign):主线时间轴 + 分支开列;
// 折叠态紧凑卡、横向/纵向双方向。

/** 节点当前有效高度(折叠 = 紧凑卡;展开 = 基础 + 泳道增量)。 */
function nodeH(n: TurnMapNode): number {
	return n.expandedExtra > 0 ? TURN_NODE_H + n.expandedExtra : TURN_NODE_COMPACT_H;
}

function turnGroup(
	turn: number,
	opts: { branch?: boolean; advisor?: boolean; events?: number } = {},
): TrajectoryTurnGroup {
	const kind: TrajectoryEvent["kind"] = opts.advisor ? "advisor" : "user";
	const events: TrajectoryEvent[] = Array.from({ length: opts.events ?? 2 }, (_, i) => ({
		id: `e${turn}-${i}`,
		kind: i === 0 ? kind : i === 1 ? "assistant" : "tool",
		title: `event ${turn}-${i}`,
		turn,
		tsMs: turn * 1000 + i,
		...(i === 0 && opts.branch ? { branch: true } : {}),
	}));
	return {
		turn,
		events,
		firstTs: new Date(turn * 1000).toISOString(),
		startMs: turn * 1000,
		endMs: turn * 1000 + (opts.events ?? 2),
	};
}

describe("layoutTurnMap", () => {
	it("全主线:节点数 = 轮数,顺序 y 堆叠,主线边 n-1 条", () => {
		const turns = [turnGroup(1), turnGroup(2), turnGroup(3), turnGroup(4)];
		const layout = layoutTurnMap(turns);
		expect(layout.nodes.length).toBe(4);
		expect(layout.main.length).toBe(4);
		expect(layout.nodes.every(n => n.lane === 0 && !n.branch)).toBe(true);
		expect(layout.nodes.map(n => n.y)).toEqual([
			0,
			TURN_NODE_H + TURN_GAP_Y,
			(TURN_NODE_H + TURN_GAP_Y) * 2,
			(TURN_NODE_H + TURN_GAP_Y) * 3,
		]);
		expect(layout.edges.length).toBe(3);
		expect(layout.edges.every(e => !e.branch)).toBe(true);
		expect(layout.lanes.length).toBe(0);
	});

	it("分支轮:横向开列,来源 = 上一主线轮,带贝塞尔分支边", () => {
		// turn 3 是重答分支(轮首事件 branch)。
		const turns = [turnGroup(1), turnGroup(2), turnGroup(3, { branch: true }), turnGroup(4)];
		const layout = layoutTurnMap(turns);
		const branchNode = layout.nodes.find(n => n.group.turn === 3);
		expect(branchNode?.branch).toBe(true);
		expect(branchNode?.lane).toBe(1);
		expect(branchNode?.sourceTurn).toBe(2);
		expect(branchNode?.x).toBe(TURN_NODE_W + TURN_LANE_GAP);
		const branchEdge = layout.edges.find(e => e.branch);
		expect(branchEdge?.from.group.turn).toBe(2);
		expect(branchEdge?.to.group.turn).toBe(3);
		// 主线仍只有 3 轮(分支轮不占主线列)。
		expect(layout.main.map(n => n.group.turn)).toEqual([1, 2, 4]);
		// 列头数据存在。
		expect(layout.lanes.length).toBe(1);
		expect(layout.lanes[0]?.sourceTurn).toBe(2);
	});

	it("连续分支轮共用一列;主线轮后重置新列", () => {
		const turns = [
			turnGroup(1),
			turnGroup(2, { branch: true }),
			turnGroup(3, { branch: true }),
			turnGroup(4),
			turnGroup(5, { branch: true }),
		];
		const layout = layoutTurnMap(turns);
		expect(layout.nodes.find(n => n.group.turn === 2)?.lane).toBe(1);
		expect(layout.nodes.find(n => n.group.turn === 3)?.lane).toBe(1);
		expect(layout.nodes.find(n => n.group.turn === 5)?.lane).toBe(2);
		expect(layout.lanes.length).toBe(2);
	});

	it("展开态:同列后续节点 y 被推开(展开高度参与布局)", () => {
		const turns = [turnGroup(1, { events: 5 }), turnGroup(2), turnGroup(3)];
		const collapsed = layoutTurnMap(turns);
		const expanded = layoutTurnMap(turns, new Set([1]));
		const extra = turnExpandedExtra(5);
		expect(extra).toBe(5 * 24 + 16);
		expect(expanded.nodes[0]?.expandedExtra).toBe(extra);
		expect(expanded.nodes[1]?.y).toBe((collapsed.nodes[1]?.y ?? 0) + extra);
		// 后续主线轮一并推开。
		expect(expanded.nodes[2]?.y).toBe((collapsed.nodes[2]?.y ?? 0) + extra);
	});

	it("顾问轮:advisor 标记传播到节点(薄荷青徽章)", () => {
		const layout = layoutTurnMap([turnGroup(1), turnGroup(2, { advisor: true })]);
		expect(layout.nodes.find(n => n.group.turn === 2)?.advisor).toBe(true);
		expect(layout.nodes.find(n => n.group.turn === 1)?.advisor).toBe(false);
	});

	it("画布尺寸覆盖全部节点(分支列计入宽度)", () => {
		const layout = layoutTurnMap([turnGroup(1), turnGroup(2, { branch: true })]);
		expect(layout.width).toBe(2 * TURN_NODE_W + TURN_LANE_GAP);
		// 高度覆盖所有节点的底部(含间距);紧凑卡下世界随内容收缩。
		const bottom = Math.max(...layout.nodes.map(n => n.y + nodeH(n)));
		expect(layout.height).toBeGreaterThanOrEqual(bottom + TURN_GAP_Y);
	});

	it("折叠态(默认):节点有效高度 = 紧凑卡高", () => {
		const layout = layoutTurnMap([turnGroup(1), turnGroup(2)]);
		expect(layout.nodes.every(n => n.h === TURN_NODE_COMPACT_H)).toBe(true);
		// 展开后 h 切到基础卡 + 泳道增量。
		const expanded = layoutTurnMap([turnGroup(1)], new Set([1]));
		expect(expanded.nodes[0]!.h).toBe(TURN_NODE_H + turnExpandedExtra(2));
	});

	it("轮前元事件组(turn 0,无 user 事件)不发节点", () => {
		// 会话开头的 model_change / custom 元事件落在 turn 0 组,不构成
		// 一轮——地图不为其发节点(实机:164 轮会话曾多出一张空卡)。
		const meta: TrajectoryTurnGroup = {
			turn: 0,
			events: [
				{ id: "meta-1", kind: "system", title: "model_change", turn: 0, tsMs: 10 },
				{ id: "meta-2", kind: "system", title: "session start", turn: 0, tsMs: 20 },
			],
			startMs: 10,
			endMs: 20,
		};
		const layout = layoutTurnMap([meta, turnGroup(1), turnGroup(2)]);
		expect(layout.nodes.length).toBe(2);
		expect(layout.nodes.map(n => n.group.turn)).toEqual([1, 2]);
		expect(layout.edges.length).toBe(1);
	});
});

describe("layoutTurnMap 横向布局", () => {
	it("主线沿 X 轴水平推进(y=0),分支车道纵向开行", () => {
		const turns = [turnGroup(1), turnGroup(2), turnGroup(3, { branch: true }), turnGroup(4)];
		const layout = layoutTurnMap(turns, new Set(), "h");
		// 主线:y 全为 0,x 按序递增,步长 = 卡宽 + 间距。
		expect(layout.main.map(n => n.y)).toEqual([0, 0, 0]);
		expect(layout.main.map(n => n.x)).toEqual([0, TURN_NODE_W + TURN_GAP_Y, (TURN_NODE_W + TURN_GAP_Y) * 2]);
		// 分支轮:转置几何——y = 车道行基准(H + LANE_GAP),x 从分叉源右缘起。
		const branch = layout.nodes.find(n => n.group.turn === 3)!;
		expect(branch.branch).toBe(true);
		expect(branch.y).toBe(TURN_NODE_H + TURN_LANE_GAP);
		expect(branch.x).toBeGreaterThanOrEqual(TURN_NODE_W + TURN_GAP_Y);
		expect(branch.sourceTurn).toBe(2);
		// 分支边仍从主线源连到分支轮。
		const branchEdge = layout.edges.find(e => e.branch);
		expect(branchEdge?.from.group.turn).toBe(2);
		expect(branchEdge?.to.group.turn).toBe(3);
		// 尺寸转置:宽由主线链决定,高由车道数决定。
		expect(layout.width).toBeGreaterThan(TURN_NODE_W * 2);
		expect(layout.height).toBe(2 * TURN_NODE_H + TURN_LANE_GAP);
	});

	it("连续分支轮共用一行(向右排),新车道另起一行", () => {
		const turns = [
			turnGroup(1),
			turnGroup(2, { branch: true }),
			turnGroup(3, { branch: true }),
			turnGroup(4),
			turnGroup(5, { branch: true }),
		];
		const layout = layoutTurnMap(turns, new Set(), "h");
		const t2 = layout.nodes.find(n => n.group.turn === 2)!;
		const t3 = layout.nodes.find(n => n.group.turn === 3)!;
		const t5 = layout.nodes.find(n => n.group.turn === 5)!;
		expect(t2.lane).toBe(1);
		expect(t3.lane).toBe(1);
		expect(t5.lane).toBe(2);
		// 同行:x 递增、y 相同;新行:y 更靠下。
		expect(t3.x).toBe(t2.x + TURN_NODE_W + TURN_GAP_Y);
		expect(t3.y).toBe(t2.y);
		expect(t5.y).toBeGreaterThan(t2.y);
	});

	it("展开的分支轮把后续车道行推开(行底水位)", () => {
		// t2 = 车道 1(展开);t3 = 主线;t4 = 车道 2 —— 新行必须在展开卡之下。
		const turns = [
			turnGroup(1),
			turnGroup(2, { branch: true, events: 8 }),
			turnGroup(3),
			turnGroup(4, { branch: true }),
		];
		const collapsed = layoutTurnMap(turns, new Set(), "h");
		const expanded = layoutTurnMap(turns, new Set([2]), "h");
		const extra = turnExpandedExtra(8);
		const c4 = collapsed.nodes.find(n => n.group.turn === 4)!;
		const e4 = expanded.nodes.find(n => n.group.turn === 4)!;
		const expandedBranch = expanded.nodes.find(n => n.group.turn === 2)!;
		// 展开增量把下一行推到展开卡底部之下,不重叠。
		expect(e4.y).toBeGreaterThanOrEqual(expandedBranch.y + TURN_NODE_H + extra);
		// 无展开时行位即车道基准。
		expect(c4.y).toBe(2 * (TURN_NODE_H + TURN_LANE_GAP));
	});

	it("横向视口裁剪按 X 轴命中(X 区间外的节点剔除)", () => {
		const turns = Array.from({ length: 12 }, (_, i) => turnGroup(i + 1));
		const layout = layoutTurnMap(turns, new Set(), "h");
		// 视口只覆盖最左 2.5 张卡的水平区间。
		const vp = { left: 0, top: -50, right: TURN_NODE_W * 2 + TURN_GAP_Y / 2, bottom: TURN_NODE_H + 50 };
		const vis = visibleTurnMapNodes(layout.nodes, vp, 0);
		expect(vis.length).toBeGreaterThanOrEqual(2);
		expect(vis.length).toBeLessThan(layout.nodes.length);
		for (const n of vis) {
			expect(n.x + TURN_NODE_W).toBeGreaterThanOrEqual(0);
			expect(n.x).toBeLessThanOrEqual(TURN_NODE_W * 2 + TURN_GAP_Y / 2);
		}
	});
});

describe("visibleTurnMapNodes", () => {
	it("只保留视口内(含 pad)的节点,视口外剔除", async () => {
		const { visibleTurnMapNodes } = await import("../src/components/turn-map-layout");
		const turns = Array.from({ length: 20 }, (_, i) => turnGroup(i + 1));
		const layout = layoutTurnMap(turns);
		// 视口只覆盖 y ∈ [500, 1000](世界坐标,pad=0):应命中 y 落区间的节点。
		const vp = { left: -100, top: 500, right: 400, bottom: 1000 };
		const vis = visibleTurnMapNodes(layout.nodes, vp, 0);
		expect(vis.length).toBeGreaterThan(0);
		expect(vis.length).toBeLessThan(layout.nodes.length);
		for (const n of vis) {
			expect(n.y + nodeH(n)).toBeGreaterThanOrEqual(500);
			expect(n.y).toBeLessThanOrEqual(1000);
		}
		// 其余节点确实在视口外。
		const visTurns = new Set(vis.map(n => n.group.turn));
		for (const n of layout.nodes) {
			if (visTurns.has(n.group.turn)) continue;
			expect(n.y > 1000 || n.y + nodeH(n) < 500).toBe(true);
		}
	});

	it("pad 外扩召回边缘节点;全图视口 = 全量", async () => {
		const { visibleTurnMapNodes } = await import("../src/components/turn-map-layout");
		const turns = Array.from({ length: 10 }, (_, i) => turnGroup(i + 1));
		const layout = layoutTurnMap(turns);
		const first = layout.nodes[0]!;
		// 视口紧贴第一个节点下方 100px:pad 260 应把它召回。
		const vp = {
			left: 0,
			top: first.y + nodeH(first) + 100,
			right: TURN_NODE_W,
			bottom: first.y + nodeH(first) + 200,
		};
		const vis = visibleTurnMapNodes(layout.nodes, vp);
		expect(vis.some(n => n.group.turn === first.group.turn)).toBe(true);
		// 覆盖全图的视口 = 全量返回。
		const all = visibleTurnMapNodes(layout.nodes, { left: 0, top: 0, right: layout.width, bottom: layout.height }, 0);
		expect(all.length).toBe(layout.nodes.length);
	});

	it("展开节点的增量高度参与命中判定", async () => {
		const { visibleTurnMapNodes } = await import("../src/components/turn-map-layout");
		const turns = [turnGroup(1, { events: 30 }), turnGroup(2), turnGroup(3)];
		const layout = layoutTurnMap(turns, new Set([1]));
		const expanded = layout.nodes[0]!;
		expect(expanded.expandedExtra).toBe(30 * 24 + 16);
		// 视口下缘落在卡基础高之下、展开增量之内:必须仍命中。
		const yInside = expanded.y + TURN_NODE_H + 100;
		const vis = visibleTurnMapNodes(
			layout.nodes,
			{ left: 0, top: yInside, right: TURN_NODE_W, bottom: yInside + 50 },
			0,
		);
		expect(vis.some(n => n.group.turn === 1)).toBe(true);
	});
});
