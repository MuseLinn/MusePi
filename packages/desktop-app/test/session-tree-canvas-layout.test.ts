import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { layoutTree } from "../src/components/SessionTreeCanvas";
import { buildMessageTree } from "../src/lib/message-tree";

// SessionTreeCanvas 的布局纯函数:深链折叠(长会话地图不塌成 22k px 竖线)。
// 折叠只压缩"无分支单子链"的纵向空白,分支结构、段内信息都不丢(展开恢复)。

function msg(id: string, parentId: string | null, ts = 1, role: string = "user"): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role },
	};
}

/** 构建一条 n 节点的线性链 entries。 */
function chainEntries(n: number, prefix = "m"): unknown[] {
	const entries: unknown[] = [msg(`${prefix}0`, null, 1)];
	for (let i = 1; i < n; i++) entries.push(msg(`${prefix}${i}`, `${prefix}${i - 1}`, i + 1));
	return entries;
}

describe("layoutTree 深链折叠", () => {
	it("短链(< 阈值)不折叠,全节点可见", () => {
		const tree = buildMessageTree(chainEntries(10));
		const laid = layoutTree(tree);
		expect(laid.nodes).toHaveLength(10);
		expect(laid.folds).toHaveLength(0);
		// 无 entries 参数 → 全部归 turn 0,同轮紧凑堆叠(卡片间 12px 空隙,
		// 起点差 = NODE_H + 12 = 52,不重叠)。height = 最后节点底部 + 尾部留白。
		expect(laid.height).toBe(40 + 9 * 52 + 64);
	});

	it("传 entries 时按轮分组:同轮紧凑、轮间大间距", () => {
		// 两轮:user0→assistant0(turn1), user1→assistant1(turn2)。
		const entries = [
			msg("u0", null, 1, "user"),
			msg("a0", "u0", 2, "assistant"),
			msg("u1", "a0", 3, "user"),
			msg("a1", "u1", 4, "assistant"),
		];
		const tree = buildMessageTree(entries);
		const laid = layoutTree(tree, entries);
		expect(laid.nodes).toHaveLength(4);
		const y = (id: string) => laid.nodes.find(n => n.node.id === id)!.y;
		// 同轮:u0→a0 卡片间 12px 空隙(起点差 NODE_H+12=52,不重叠)。
		expect(y("a0") - y("u0")).toBe(52);
		expect(y("a1") - y("u1")).toBe(52);
		// 轮间:u1 从 a0 卡片间大间距 64px(起点差 NODE_H+64=104)。
		expect(y("u1") - y("a0")).toBe(104);
	});

	it("任何相邻节点卡片不重叠(同轮 12px 空隙,起点差含 NODE_H)", () => {
		// 回归:同轮间距误用 12px 作起点差 → assistant 卡片盖在 user 底部
		// 28px,文字糊一起。布局必须保证任意可见节点卡片不重叠。
		// 折叠段内节点(渲染时隐藏)除外——它们堆叠在段首下,不参与视觉。
		const entries = [
			msg("u0", null, 1, "user"),
			msg("a0", "u0", 2, "assistant"),
			msg("u1", "a0", 3, "user"),
			msg("a1", "u1", 4, "assistant"),
		];
		const laid = layoutTree(buildMessageTree(entries), entries);
		const hidden = new Set(laid.folds.flatMap(f => f.hiddenIds));
		const visible = laid.nodes.filter(n => !hidden.has(n.node.id)).sort((a, b) => a.y - b.y);
		for (let i = 1; i < visible.length; i++) {
			expect(visible[i]!.y - visible[i - 1]!.y).toBeGreaterThanOrEqual(40);
		}
	});

	it("60 轮长会话折叠后可见节点仍不重叠", () => {
		// 用户实际场景:长会话(60 轮交替)触发深链折叠,折叠后可见的
		// 段首/链尾节点必须互不重叠。
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
		expect(laid.folds.length).toBeGreaterThan(0);
		const hidden = new Set(laid.folds.flatMap(f => f.hiddenIds));
		const visible = laid.nodes.filter(n => !hidden.has(n.node.id)).sort((a, b) => a.y - b.y);
		for (let i = 1; i < visible.length; i++) {
			expect(visible[i]!.y - visible[i - 1]!.y).toBeGreaterThanOrEqual(40);
		}
		// 全部在画布内。
		for (const n of laid.nodes) {
			expect(n.y).toBeGreaterThanOrEqual(0);
			expect(n.y).toBeLessThan(laid.height);
		}
	});

	it("长链(> 阈值)折叠成段,画布高度大幅缩小", () => {
		const tree = buildMessageTree(chainEntries(120));
		const laid = layoutTree(tree);
		expect(laid.nodes).toHaveLength(120);
		// 至少产生一个折叠段。
		expect(laid.folds.length).toBeGreaterThan(0);
		// 折叠后画布高度显著小于不折叠的 120 层高度。
		const unfoldedH = 120 * (40 + 64);
		expect(laid.height).toBeLessThan(unfoldedH * 0.6);
	});

	it("折叠段内节点不占画布高度,但段信息完整", () => {
		const tree = buildMessageTree(chainEntries(100));
		const laid = layoutTree(tree);
		const fold = laid.folds[0];
		expect(fold).toBeDefined();
		// 段首在画布上,段内节点被隐藏(不参与高度)。
		const head = laid.nodes.find(n => n.node.id === fold!.headId);
		expect(head).toBeDefined();
		// 段内节点全部记录在 hiddenIds,数量 = 段长 - 1。
		expect(fold!.hiddenIds.length).toBeGreaterThan(0);
		for (const hid of fold!.hiddenIds) {
			expect(laid.nodes.some(n => n.node.id === hid)).toBe(true);
		}
	});

	it("分支打断链段:分支点之后的节点不被折叠隐藏", () => {
		// 100 节点链,中间(50)处岔出兄弟 → 链段在分支处断开。
		const entries: unknown[] = chainEntries(100);
		entries.push(msg("fork", "m49", 200), msg("fork-child", "fork", 201));
		const tree = buildMessageTree(entries);
		const laid = layoutTree(tree);
		// 折叠段不应包含分支点 m49 之后的节点(fork/fork-child 一定可见)。
		const hiddenIds = new Set<string>();
		for (const f of laid.folds) for (const h of f.hiddenIds) hiddenIds.add(h);
		expect(hiddenIds.has("fork")).toBe(false);
		expect(hiddenIds.has("fork-child")).toBe(false);
	});

	it("折叠段首是胶囊且保留交互语义(段首节点仍在 nodes)", () => {
		const tree = buildMessageTree(chainEntries(80));
		const laid = layoutTree(tree);
		expect(laid.folds.length).toBeGreaterThan(0);
		// 每个折叠段的 headId 都对应一个真实节点。
		for (const f of laid.folds) {
			expect(laid.nodes.some(n => n.node.id === f.headId)).toBe(true);
		}
	});

	it("折叠后所有节点 y 都在画布内(段首依次堆叠,不越界裁剪)", () => {
		// 回归:折叠只压缩了 height,段首 y 仍按真实深度算 → 后段全部
		// 画在画布外被裁剪("地图只显示一小段")。修复后视觉 y 上移,
		// 每个节点(含段内堆叠)必须落在 [0, height) 内。
		const tree = buildMessageTree(chainEntries(120));
		const laid = layoutTree(tree);
		expect(laid.folds.length).toBeGreaterThan(1);
		for (const n of laid.nodes) {
			expect(n.y).toBeGreaterThanOrEqual(0);
			expect(n.y).toBeLessThan(laid.height);
		}
		// 段首依次堆叠:相邻折叠段的段首 y 单调递增且都在画布内。
		const heads = laid.folds.map(f => laid.nodes.find(n => n.node.id === f.headId)!.y).sort((a, b) => a - b);
		for (let i = 1; i < heads.length; i++) {
			expect(heads[i]!).toBeGreaterThan(heads[i - 1]!);
		}
	});

	it("多根独立折叠互不影响(不跨子树错误压缩)", () => {
		// 回归:全局 hiddenBefore 累计会把 A 根的折叠隐藏数算进 B 根的
		// 段首 → B 段首 y 变负数被裁剪。视觉深度游标法按根独立推进。
		const entries: unknown[] = chainEntries(100, "a");
		for (let i = 0; i < 100; i++) {
			entries.push(msg(`b${i}`, i === 0 ? null : `b${i - 1}`, 500 + i));
		}
		const laid = layoutTree(buildMessageTree(entries));
		expect(laid.folds.length).toBeGreaterThan(1);
		for (const n of laid.nodes) {
			expect(n.y).toBeGreaterThanOrEqual(0);
			expect(n.y).toBeLessThan(laid.height);
		}
		// B 根的段首必须 >= 0(旧实现会压成负数)。
		for (const f of laid.folds) {
			if (!f.headId.startsWith("b")) continue;
			const head = laid.nodes.find(n => n.node.id === f.headId)!;
			expect(head.y).toBeGreaterThanOrEqual(0);
		}
	});

	it("分支混合场景:分支点后继续的深链仍折叠且全部在画布内", () => {
		// 200 链在 m100 岔出 20 深分支——分支点打断链段,分支后主链
		// 继续深链折叠;分支链独立折叠。全部节点必须在画布内。
		const entries: unknown[] = [msg("r", null, 1)];
		for (let i = 1; i < 200; i++) entries.push(msg(`m${i}`, i === 1 ? "r" : `m${i - 1}`, i + 1));
		let prev = "fork0";
		entries.push(msg(prev, "m100", 300));
		for (let i = 1; i < 20; i++) {
			const id = `fork${i}`;
			entries.push(msg(id, prev, 300 + i));
			prev = id;
		}
		const laid = layoutTree(buildMessageTree(entries));
		// 分支点与分支链不被折叠隐藏。
		const hidden = new Set<string>();
		for (const f of laid.folds) for (const h of f.hiddenIds) hidden.add(h);
		expect(hidden.has("m100")).toBe(false);
		expect(hidden.has("fork0")).toBe(false);
		for (const n of laid.nodes) {
			expect(n.y).toBeGreaterThanOrEqual(0);
			expect(n.y).toBeLessThan(laid.height);
		}
	});

	it("多段折叠:超长链拆成多段,每段独立展开", () => {
		const tree = buildMessageTree(chainEntries(300));
		const laid = layoutTree(tree);
		expect(laid.folds.length).toBeGreaterThan(1);
		// 各段 headId 互不重叠。
		const heads = laid.folds.map(f => f.headId);
		expect(new Set(heads).size).toBe(heads.length);
	});

	it("空树:零节点零折叠", () => {
		const laid = layoutTree([]);
		expect(laid.nodes).toHaveLength(0);
		expect(laid.folds).toHaveLength(0);
		expect(laid.width).toBeGreaterThan(0);
		expect(laid.height).toBeGreaterThan(0);
	});
});
