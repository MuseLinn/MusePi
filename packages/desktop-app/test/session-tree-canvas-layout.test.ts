import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { layoutTree } from "../src/components/SessionTreeCanvas";
import { buildMessageTree } from "../src/lib/message-tree";

// SessionTreeCanvas 的布局纯函数:分层排布 + 轮级分组。
// 地图不折叠链段(折叠是线性 transcript 的压缩手段):每个条目都占自己的
// 行位,长会话靠缩放/平移读。

/** 卡片高度 / 轮内·轮间间距(与组件常量同值:布局断言直接算出来)。 */
const NODE_H = 76;
const GAP_Y = 64;
const GAP_Y_TURN = 12;

function msg(id: string, parentId: string | null, ts = 1, role: string = "user"): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role, content: [{ type: "text", text: `${role} ${id}` }] },
	};
}

/** 构建一条 n 节点的线性链 entries。 */
function chainEntries(n: number, prefix = "m"): unknown[] {
	const entries: unknown[] = [msg(`${prefix}0`, null, 1)];
	for (let i = 1; i < n; i++) entries.push(msg(`${prefix}${i}`, `${prefix}${i - 1}`, i + 1));
	return entries;
}

describe("layoutTree 分层布局", () => {
	it("线性链每个节点都有自己的行位(同轮 12px 空隙)", () => {
		const laid = layoutTree(buildMessageTree(chainEntries(10)));
		expect(laid.nodes).toHaveLength(10);
		// 无 entries 参数 → 全部归 turn 0,同轮紧凑堆叠:起点差 = NODE_H + 12。
		const ys = laid.nodes.map(n => n.y).sort((a, b) => a - b);
		expect(ys).toEqual([...Array(10).keys()].map(i => i * (NODE_H + GAP_Y_TURN)));
		// height = 末节点底部 + 尾部留白。
		expect(laid.height).toBe(9 * (NODE_H + GAP_Y_TURN) + NODE_H + GAP_Y);
	});

	it("传 entries 时按轮分组:同轮紧凑、轮间大间距", () => {
		// 两轮:user0→assistant0(turn1), user1→assistant1(turn2)。
		const entries = [
			msg("u0", null, 1, "user"),
			msg("a0", "u0", 2, "assistant"),
			msg("u1", "a0", 3, "user"),
			msg("a1", "u1", 4, "assistant"),
		];
		const laid = layoutTree(buildMessageTree(entries), entries);
		expect(laid.nodes).toHaveLength(4);
		const y = new Map(laid.nodes.map(n => [n.node.id, n.y]));
		// 同轮:u0→a0 卡片间 12px 空隙(起点差 NODE_H+12,不重叠)。
		expect(y.get("a0")! - y.get("u0")!).toBe(NODE_H + GAP_Y_TURN);
		expect(y.get("a1")! - y.get("u1")!).toBe(NODE_H + GAP_Y_TURN);
		// 轮间:u1 与 a0 之间大间距(起点差 NODE_H+64)。
		expect(y.get("u1")! - y.get("a0")!).toBe(NODE_H + GAP_Y);
	});

	it("任何相邻节点卡片不重叠(起点差至少 NODE_H)", () => {
		// 回归:同轮间距误用 12px 作起点差 → 卡片互相盖住,文字糊一起。
		const entries = [
			msg("u0", null, 1, "user"),
			msg("a0", "u0", 2, "assistant"),
			msg("u1", "a0", 3, "user"),
			msg("a1", "u1", 4, "assistant"),
		];
		const laid = layoutTree(buildMessageTree(entries), entries);
		const sorted = [...laid.nodes].sort((a, b) => a.y - b.y);
		for (let i = 1; i < sorted.length; i++) {
			expect(sorted[i]!.y - sorted[i - 1]!.y).toBeGreaterThanOrEqual(NODE_H);
		}
	});

	it("长会话(120 节点)不隐藏任何节点,且全部落在画布内", () => {
		// 用户实际场景:长会话不折叠 → 每个条目都有自己的卡片与行位。
		const entries: unknown[] = [];
		let prev: string | null = null;
		for (let i = 0; i < 60; i++) {
			const uid = `u${i}`;
			entries.push(msg(uid, prev, i * 2 + 1, "user"));
			const aid = `a${i}`;
			entries.push(msg(aid, uid, i * 2 + 2, "assistant"));
			prev = aid;
		}
		const laid = layoutTree(buildMessageTree(entries), entries);
		expect(laid.nodes).toHaveLength(120);
		// 行位两两不同(没有节点被藏起来或堆在同一坐标)。
		expect(new Set(laid.nodes.map(n => n.y)).size).toBe(120);
		for (const n of laid.nodes) {
			expect(n.y).toBeGreaterThanOrEqual(0);
			expect(n.y).toBeLessThan(laid.height);
		}
	});

	it("分支场景:分支点与分支链全部可见", () => {
		// 100 节点链,中间(m49)岔出兄弟 → 两条链各自排布,谁都不被折叠隐藏。
		const entries: unknown[] = chainEntries(100);
		entries.push(msg("fork", "m49", 200), msg("fork-child", "fork", 201));
		const laid = layoutTree(buildMessageTree(entries));
		expect(laid.nodes).toHaveLength(102);
		const y = new Map(laid.nodes.map(n => [n.node.id, n.y]));
		// 分支从父下方继续推进。
		expect(y.get("fork")!).toBeGreaterThan(y.get("m49")!);
		expect(y.get("fork-child")!).toBeGreaterThan(y.get("fork")!);
		for (const n of laid.nodes) {
			expect(n.y).toBeLessThan(laid.height);
		}
	});

	it("多根各自从 y=0 起排,横向分列互不挤压", () => {
		const entries: unknown[] = chainEntries(100, "a");
		for (let i = 0; i < 100; i++) {
			entries.push(msg(`b${i}`, i === 0 ? null : `b${i - 1}`, 500 + i));
		}
		const laid = layoutTree(buildMessageTree(entries));
		const a0 = laid.nodes.find(n => n.node.id === "a0")!;
		const b0 = laid.nodes.find(n => n.node.id === "b0")!;
		expect(a0.y).toBe(0);
		expect(b0.y).toBe(0);
		expect(a0.x).not.toBe(b0.x);
		for (const n of laid.nodes) {
			expect(n.y).toBeGreaterThanOrEqual(0);
			expect(n.y).toBeLessThan(laid.height);
		}
	});

	it("空树:零节点,画布仍有尺寸", () => {
		const laid = layoutTree([]);
		expect(laid.nodes).toHaveLength(0);
		expect(laid.width).toBeGreaterThan(0);
		expect(laid.height).toBeGreaterThan(0);
	});
});
