import { describe, expect, it } from "bun:test";
import type { TrajectoryEvent, TrajectoryTurnGroup } from "../src/components/trajectory-data";
import {
	layoutTurnMap,
	TURN_GAP_Y,
	TURN_LANE_GAP,
	TURN_NODE_H,
	TURN_NODE_W,
	turnExpandedExtra,
} from "../src/components/turn-map-layout";

// 轮级会话地图布局(0.5.0-map-redesign):主线垂直时间轴 + 分支横向开列。

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
		expect(layout.height).toBeGreaterThan(TURN_NODE_H * 2);
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
