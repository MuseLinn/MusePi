import { describe, expect, it } from "bun:test";
import type { TrajectoryEvent, TrajectoryTurnGroup } from "../src/components/trajectory-data";
import {
	arrowTriangle,
	edgePathD,
	layoutTurnMap,
	TURN_ARROW_HALF,
	TURN_ARROW_LEN,
	TURN_BRANCH_LANE_OFFSET,
	TURN_BRANCH_STEM,
	TURN_GAP_Y,
	TURN_LANE_GAP,
	TURN_NODE_H,
	TURN_NODE_W,
	type TurnMapNode,
	type TurnMapPoint,
	visibleTurnMapNodes,
} from "../src/components/turn-map-layout";

// 轮级会话地图布局:固定高度索引卡 + 正交带箭头连线 + 每支一条车道。
//
// 这组断言回答的是用户原话里的三个问题:「谁生了谁」(边方向)、「分叉在
// 哪」(分裂点与车道)、「这一轮是什么」(卡片高度与计数),而不是像素口味。

/** 轮组 fixture:branch = 该轮首事件带分支标记(即离路径)。 */
function turnGroup(
	turn: number,
	opts: { branch?: boolean; advisor?: boolean; events?: number; id?: string; parentId?: string } = {},
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
		id: opts.id,
		parentId: opts.parentId,
		events,
		firstTs: new Date(turn * 1000).toISOString(),
		startMs: turn * 1000,
		endMs: turn * 1000 + (opts.events ?? 2),
	};
}

/** 带稳定 id/parentId 的轮组:分支轮的父轮由 parentId 解析。 */
function linked(turn: number, id: string, parentId?: string, branch = false): TrajectoryTurnGroup {
	return {
		turn,
		id,
		parentId,
		displayTurn: turn,
		// 与 groupTrajectoryTurns 同源:轮首事件带 branch = 该轮不在活跃路径上。
		offPath: branch || undefined,
		events: [
			{
				id: `${id}-e`,
				entryId: id,
				kind: "user",
				title: id,
				turn,
				pathTurn: turn,
				tsMs: turn * 1000,
				branch: branch || undefined,
			},
		],
		firstTs: new Date(turn * 1000).toISOString(),
		startMs: turn * 1000,
		endMs: turn * 1000 + 1,
	};
}

describe("卡片是固定高度的索引行", () => {
	it("每一轮都是同一个高度,与事件数无关", () => {
		// 旧实现:折叠 40px / 展开 88px + 泳道增量,事件多的轮能把卡撑到几百 px。
		// 契约:地图是索引,轮内事件数不影响卡高。
		const few = layoutTurnMap([turnGroup(1, { events: 2 })]);
		const many = layoutTurnMap([turnGroup(1, { events: 40 })]);
		expect(few.nodes[0]!.h).toBe(TURN_NODE_H);
		expect(many.nodes[0]!.h).toBe(TURN_NODE_H);
	});

	it("后续轮的位移只由固定卡高 + 间距决定(没有展开增量参与)", () => {
		const layout = layoutTurnMap([turnGroup(1, { events: 30 }), turnGroup(2), turnGroup(3)]);
		expect(layout.nodes.map(n => n.y)).toEqual([0, TURN_NODE_H + TURN_GAP_Y, (TURN_NODE_H + TURN_GAP_Y) * 2]);
	});

	it("横向布局:主线沿 X 推进,行高固定", () => {
		const layout = layoutTurnMap([turnGroup(1), turnGroup(2), turnGroup(3)], { direction: "h" });
		expect(layout.main.map(n => n.y)).toEqual([0, 0, 0]);
		expect(layout.main.map(n => n.x)).toEqual([0, TURN_NODE_W + TURN_GAP_Y, (TURN_NODE_W + TURN_GAP_Y) * 2]);
		expect(layout.main.every(n => n.h === TURN_NODE_H)).toBe(true);
	});
});

describe("边表达方向:正交折线 + 箭头", () => {
	it("主线边是两点直线,箭头在子轮一侧并指向子轮", () => {
		const layout = layoutTurnMap([turnGroup(1), turnGroup(2)]);
		const edge = layout.edges[0]!;
		expect(edge.points).toHaveLength(2);
		const [start, end] = edge.points as [{ x: number; y: number }, { x: number; y: number }];
		// 纵向:起点在父轮底缘中心,终点在子轮顶缘中心。
		expect(start.y).toBe(TURN_NODE_H);
		expect(end.y).toBe(TURN_NODE_H + TURN_GAP_Y);
		expect(start.x).toBe(end.x);
		// 箭头贴着子轮顶缘,方向 = 向下(进入子轮)。
		expect(edge.arrow.dy).toBe(1);
		expect(edge.arrow.dx).toBe(0);
		expect(edge.arrow.y).toBeLessThanOrEqual(end.y);
	});

	it("横向主线:箭头指向右(进入子轮左缘)", () => {
		const layout = layoutTurnMap([turnGroup(1), turnGroup(2)], { direction: "h" });
		const edge = layout.edges[0]!;
		expect(edge.arrow.dx).toBe(1);
		expect(edge.arrow.dy).toBe(0);
		expect(edge.points[0]!.x).toBe(TURN_NODE_W);
		expect(edge.points[1]!.x).toBe(TURN_NODE_W + TURN_GAP_Y);
	});

	it("箭头三角形:尖端在 arrow 坐标,两翼在反方向两侧", () => {
		const [tip, a, b] = arrowTriangle({ x: 100, y: 50, dx: 0, dy: 1 });
		expect(tip).toEqual({ x: 100, y: 50 });
		// 两翼在尖端上方 TURN_ARROW_LEN,左右各 TURN_ARROW_HALF。
		expect(a.y).toBeCloseTo(50 - TURN_ARROW_LEN, 5);
		expect(b.y).toBeCloseTo(50 - TURN_ARROW_LEN, 5);
		expect(Math.abs(a.x - b.x)).toBeCloseTo(TURN_ARROW_HALF * 2, 5);
	});

	it("折线 path:直线段 + 折点圆角,方向不变", () => {
		const d = edgePathD([
			{ x: 0, y: 0 },
			{ x: 0, y: 10 },
			{ x: 20, y: 10 },
		]);
		expect(d.startsWith("M 0 0")).toBe(true);
		// 折点处用二次曲线过渡,终点精确落在末点。
		expect(d).toContain("Q 0 10");
		expect(d.endsWith("L 20 10")).toBe(true);
	});
});

describe("分叉是一处分裂,不是一团交叉", () => {
	it("同一父轮的两个兄弟分支各占一条车道(不共享车道互相穿越)", () => {
		// 旧实现:连续分支轮共用一条车道 → 第二条边从第一张卡身上穿过,
		// 分叉读成打结。契约:兄弟各开一列。
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true), linked(3, "u3", "u1", true), linked(4, "u4")];
		const layout = layoutTurnMap(turns);
		const b2 = layout.nodes.find(n => n.group.turn === 2)!;
		const b3 = layout.nodes.find(n => n.group.turn === 3)!;
		expect(b2.lane).toBe(1);
		expect(b3.lane).toBe(2);
		expect(b3.x).toBeGreaterThan(b2.x);
	});

	it("兄弟分支共享同一个交汇点,分裂点只记一次并带支数", () => {
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true), linked(3, "u3", "u1", true)];
		const layout = layoutTurnMap(turns);
		expect(layout.splits).toHaveLength(1);
		const split = layout.splits[0]!;
		expect(split.count).toBe(2);
		expect(split.source.group.turn).toBe(1);
		// 交汇点落在父轮之后的干线间距中点(正压在主线上)。
		const source = layout.main.find(n => n.group.turn === 1)!;
		expect(split.x).toBe(source.x + TURN_NODE_W / 2);
		expect(split.y).toBe(source.y + source.h + TURN_GAP_Y / 2);
		// 两条分支边都从这一个点出发。
		const branchEdges = layout.edges.filter(e => e.branch);
		expect(branchEdges).toHaveLength(2);
		for (const e of branchEdges) expect(e.junction).toEqual({ x: split.x, y: split.y });
	});

	it("分支边是正交折线:交汇点 → 让位点 → 走廊 → 车道通道 → 卡左缘", () => {
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true)];
		const layout = layoutTurnMap(turns);
		const edge = layout.edges.find(e => e.branch)!;
		const pts = edge.points;
		// 起点 = 交汇点。
		expect(pts[0]).toEqual(edge.junction!);
		// 落点 = 分支卡左缘中点,箭头朝右(进卡)。连线停在卡的边缘,
		// 不进入卡内部——「不穿卡」的判定因此不会把入场段算成穿透。
		const target = layout.nodes.find(n => n.group.turn === 2)!;
		expect(pts[pts.length - 1]).toEqual({ x: target.x, y: target.y + target.h / 2 });
		expect(edge.arrow.dx).toBe(1);
		expect(edge.arrow.dy).toBe(0);
		// 每一段都正交:相邻两点的 x 或 y 至少有一个相等。
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1]!;
			const b = pts[i]!;
			expect(a.x === b.x || a.y === b.y).toBe(true);
		}
		// 有可见的干线残端:第一段沿干线走出交汇点(TURN_BRANCH_STEM 或更多)。
		expect(Math.abs(pts[1]!.y - pts[0]!.y) + Math.abs(pts[1]!.x - pts[0]!.x)).toBeGreaterThanOrEqual(
			TURN_BRANCH_STEM,
		);
	});

	it("嵌套分支(父轮也是分支)留在父轮车道内,是一条垂直直线", () => {
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true), linked(3, "u3", "u2", true)];
		const layout = layoutTurnMap(turns);
		const b2 = layout.nodes.find(n => n.group.turn === 2)!;
		const b3 = layout.nodes.find(n => n.group.turn === 3)!;
		expect(b3.lane).toBe(b2.lane);
		const edge = layout.edges.find(e => e.to.group.turn === 3)!;
		// 同车道且同列:两点垂直直线,沿本车道中线下行。不能走通用走廊——
		// 走廊是「绕到行外」的,起终点在同一列时会从别的卡中间穿回来。
		expect(edge.points).toHaveLength(2);
		expect(edge.points[0]!.x).toBe(edge.points[1]!.x);
		expect(edge.points[0]!.x).toBe(b3.x + TURN_NODE_W / 2);
		expect(edge.arrow.dy).toBe(1);
	});

	it("分支卡不与主线卡重叠,也不落进父轮卡内", () => {
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true), linked(3, "u3", "u1", true), linked(4, "u4")];
		const layout = layoutTurnMap(turns);
		const source = layout.main.find(n => n.group.turn === 1)!;
		for (const b of layout.nodes.filter(n => n.branch)) {
			expect(b.x).toBeGreaterThanOrEqual(source.x + TURN_NODE_W);
			expect(b.y).toBeGreaterThanOrEqual(source.y + source.h + TURN_GAP_Y + TURN_BRANCH_LANE_OFFSET);
		}
	});

	it("车道距与卡宽共同决定世界宽度(不把分支列叠在主线列上)", () => {
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true), linked(3, "u3", "u1", true)];
		const layout = layoutTurnMap(turns);
		expect(layout.width).toBe(3 * TURN_NODE_W + 2 * TURN_LANE_GAP);
	});
});

describe("离路径:旁支后退,但不消失", () => {
	it("分支轮带 offPath,主线轮不带", () => {
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true), linked(3, "u3")];
		const layout = layoutTurnMap(turns);
		expect(layout.nodes.find(n => n.group.turn === 2)!.offPath).toBe(true);
		expect(layout.nodes.find(n => n.group.turn === 1)!.offPath).toBe(false);
		expect(layout.nodes.find(n => n.group.turn === 3)!.offPath).toBe(false);
	});

	it("边继承子轮的离路径状态(旁支的连线一起后退)", () => {
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true)];
		const layout = layoutTurnMap(turns);
		expect(layout.edges.find(e => e.branch)!.offPath).toBe(true);
	});

	it("给出对话在视集时,离路径由该集判定而不是派生标记", () => {
		// 转录显示 turn 1/2(集里有 u1、u2),turn 3 被排除 → 只有 3 是旁支,
		// 即使它的首事件没有 branch 标记。
		const turns = [linked(1, "u1"), linked(2, "u2"), linked(3, "u3")];
		const layout = layoutTurnMap(turns, { pathIds: new Set(["u1", "u2"]) });
		expect(layout.nodes.map(n => n.offPath)).toEqual([false, false, true]);
	});

	it("离路径判定与对话在视集一致:集里有的都不淡显", () => {
		const turns = [linked(1, "u1"), linked(2, "u2", "u1", true), linked(3, "u3", "u1", true)];
		// 转录显示 turn 1 与第二个分支(turn 3),第一个分支(turn 2)被撤回。
		const layout = layoutTurnMap(turns, { pathIds: new Set(["u1", "u3"]) });
		expect(layout.nodes.find(n => n.group.turn === 1)!.offPath).toBe(false);
		expect(layout.nodes.find(n => n.group.turn === 2)!.offPath).toBe(true);
		expect(layout.nodes.find(n => n.group.turn === 3)!.offPath).toBe(false);
	});
});

describe("轮前元事件与顾问轮", () => {
	it("轮前元事件组(turn 0,无 user 事件)不发节点", () => {
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
		expect(layout.nodes.map(n => n.group.turn)).toEqual([1, 2]);
		expect(layout.edges).toHaveLength(1);
	});

	it("顾问轮:advisor 标记传播到节点", () => {
		const layout = layoutTurnMap([turnGroup(1), turnGroup(2, { advisor: true })]);
		expect(layout.nodes.find(n => n.group.turn === 2)!.advisor).toBe(true);
		expect(layout.nodes.find(n => n.group.turn === 1)!.advisor).toBe(false);
	});
});

describe("连线不许穿过卡片(枚举 5/6/7 轮的全部父指派)", () => {
	/**
	 * 评审 P1-3:分支边的水平段只清交汇点 6px,于是「更早的兄弟车道占住那一
	 * 列」时连线从它的卡背面穿过(可达形状 t1/t2/t3 + t4(off t1) +
	 * t5(off t4) + t6(off t3):`t3→t6` 在 y=254 穿过 t5 208px)。
	 *
	 * 这里是穷举,而不是挑几个形状:5 轮 = 120 种指派、6 轮 = 720、7 轮 =
	 * 5040,纵向与横向各一遍,共 11760 张布局。断言两件事:
	 *  1. 任何一段折线的内部都不落在非端点卡片内部;
	 *  2. 任何两条边都不相交(评审报告的 1352/10080 边-边交叉)。
	 */
	function groups(parents: readonly number[]): TrajectoryTurnGroup[] {
		return parents.map((parent, index) => {
			const turn = index + 1;
			const branch = parent !== index;
			return {
				turn,
				id: `t${turn}`,
				parentId: branch ? `t${parent + 1}` : undefined,
				displayTurn: turn,
				offPath: branch || undefined,
				events: [
					{
						id: `e${turn}`,
						entryId: `t${turn}`,
						kind: "user",
						title: `t${turn}`,
						turn,
						pathTurn: turn,
						tsMs: turn * 1000,
						branch: branch || undefined,
					},
				],
				firstTs: new Date(turn * 1000).toISOString(),
				startMs: turn * 1000,
				endMs: turn * 1000 + 1,
			} as TrajectoryTurnGroup;
		});
	}

	function segmentEntersCard(a: TurnMapPoint, b: TurnMapPoint, node: TurnMapNode): boolean {
		const minX = node.x;
		const maxX = node.x + TURN_NODE_W;
		const minY = node.y;
		const maxY = node.y + node.h;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (length < 1) return false;
		const steps = Math.ceil(length * 2);
		for (let i = 1; i < steps; i++) {
			const t = i / steps;
			const x = a.x + (b.x - a.x) * t;
			const y = a.y + (b.y - a.y) * t;
			// 0.5px 内缩:沿卡边走的段不算穿卡。
			if (x > minX + 0.5 && x < maxX - 0.5 && y > minY + 0.5 && y < maxY - 0.5) return true;
		}
		return false;
	}

	function segmentsCross(a1: TurnMapPoint, a2: TurnMapPoint, b1: TurnMapPoint, b2: TurnMapPoint): boolean {
		const cross = (p: TurnMapPoint, q: TurnMapPoint, r: TurnMapPoint) =>
			(q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
		const d1 = cross(b1, b2, a1);
		const d2 = cross(b1, b2, a2);
		const d3 = cross(a1, a2, b1);
		const d4 = cross(a1, a2, b2);
		return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
	}

	/** 每个轮位的父轮:parent[i] = i 表示继续主线,否则挂到 parent[i]。 */
	function assignments(count: number): number[][] {
		const out: number[][] = [];
		const walk = (acc: number[]): void => {
			if (acc.length === count) {
				out.push([...acc]);
				return;
			}
			const index = acc.length;
			for (let parent = 0; parent <= index; parent++) {
				acc.push(parent);
				walk(acc);
				acc.pop();
			}
		};
		walk([]);
		return out;
	}

	for (const count of [5, 6, 7]) {
		it(`${count} 轮 / 两个方向:没有边穿过非端点卡片,也没有边-边交叉`, () => {
			let layouts = 0;
			const penetrations: string[] = [];
			const crossings: string[] = [];
			for (const direction of ["v", "h"] as const) {
				for (const parents of assignments(count)) {
					const layout = layoutTurnMap(groups(parents), { direction });
					layouts += 1;
					for (const edge of layout.edges) {
						for (const node of layout.nodes) {
							if (node === edge.from || node === edge.to) continue;
							for (let s = 1; s < edge.points.length; s++) {
								if (segmentEntersCard(edge.points[s - 1]!, edge.points[s]!, node)) {
									penetrations.push(`${direction} ${parents.join(",")} → card ${node.group.turn}`);
								}
							}
						}
					}
					for (let i = 0; i < layout.edges.length; i++) {
						for (let j = i + 1; j < layout.edges.length; j++) {
							const a = layout.edges[i]!;
							const b = layout.edges[j]!;
							if (a.from === b.from && a.to === b.to) continue;
							let crossed = false;
							for (let s = 1; s < a.points.length && !crossed; s++) {
								for (let t = 1; t < b.points.length && !crossed; t++) {
									if (segmentsCross(a.points[s - 1]!, a.points[s]!, b.points[t - 1]!, b.points[t]!))
										crossed = true;
								}
							}
							if (crossed) crossings.push(`${direction} ${parents.join(",")}`);
						}
					}
				}
			}
			// 覆盖度自证:第 i 轮有 i+1 个父候选(0..i),所以指派数 = n!,
			// 两个方向再乘 2。
			const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
			expect(layouts).toBe(2 * factorial(count));
			expect(penetrations).toEqual([]);
			expect(crossings).toEqual([]);
		});
	}

	it("嵌套分支与后续分支共存的可达形状在枚举内被覆盖", () => {
		// t1/t2/t3 主线 + t4(off t1)+ t5(off t4)+ t6(off t3) —— 评审点名的形状。
		const layout = layoutTurnMap(groups([0, 1, 2, 0, 3, 2]));
		const t6 = layout.nodes.find(n => n.group.turn === 6)!;
		const t5 = layout.nodes.find(n => n.group.turn === 5)!;
		expect(t5.branch).toBe(true);
		expect(t6.branch).toBe(true);
		// t3→t6 的折线不进 t5 的卡内部。
		const edge = layout.edges.find(e => e.from.group.turn === 3 && e.to.group.turn === 6)!;
		for (let s = 1; s < edge.points.length; s++) {
			expect(segmentEntersCard(edge.points[s - 1]!, edge.points[s]!, t5)).toBe(false);
		}
	});
});

describe("visibleTurnMapNodes", () => {
	it("只保留视口内(含 pad)的节点", () => {
		const turns = Array.from({ length: 20 }, (_, i) => turnGroup(i + 1));
		const layout = layoutTurnMap(turns);
		const vp = { left: -100, top: 500, right: 400, bottom: 1000 };
		const vis = visibleTurnMapNodes(layout.nodes, vp, 0);
		expect(vis.length).toBeGreaterThan(0);
		expect(vis.length).toBeLessThan(layout.nodes.length);
		for (const n of vis) {
			expect(n.y + n.h).toBeGreaterThanOrEqual(500);
			expect(n.y).toBeLessThanOrEqual(1000);
		}
	});

	it("全图视口 = 全量", () => {
		const turns = Array.from({ length: 10 }, (_, i) => turnGroup(i + 1));
		const layout = layoutTurnMap(turns);
		const all = visibleTurnMapNodes(layout.nodes, { left: 0, top: 0, right: layout.width, bottom: layout.height }, 0);
		expect(all.length).toBe(layout.nodes.length);
	});
});
