import { describe, expect, it } from "bun:test";
import { buildMessageTree, flattenMessageTree } from "./message-tree";

/** message-tree 遍历的爆栈回归:线性会话的 parent→child 链一层一条消息,
 *  全量分页后数千层——递归实现(flattenMessageTree 及轨迹/画布的各个
 *  walk)直接 RangeError 进错误边界。迭代实现必须保持与原递归完全一致的
 *  行序与 isLast 语义。 */
describe("flattenMessageTree (iterative)", () => {
	function chain(n: number) {
		// root(0) → 1 → 2 → … n-1,单链。
		const nodes: unknown[] = [];
		for (let i = 0; i < n; i++) {
			nodes.push({
				id: `n${i}`,
				parentId: i === 0 ? null : `n${i - 1}`,
				timestamp: `t${i}`,
				type: "message",
				entry: null,
				children: [],
			});
		}
		return buildMessageTree(nodes);
	}

	it("flattens a 20k-deep linear chain without stack overflow", () => {
		const roots = chain(20_000);
		const rows = flattenMessageTree(roots);
		expect(rows).toHaveLength(20_000);
		expect(rows[0]!.node.id).toBe("n0");
		expect(rows[0]!.isLast).toBe(true);
		expect(rows[19_999]!.node.id).toBe("n19999");
		expect(rows[19_999]!.depth).toBe(19_999);
	});

	it("keeps sibling order and isLast semantics on a branched tree", () => {
		const entries = [
			{ id: "a", parentId: null, timestamp: "1", type: "message" },
			{ id: "b", parentId: "a", timestamp: "2", type: "message" },
			{ id: "c", parentId: "a", timestamp: "3", type: "message" },
			{ id: "d", parentId: "c", timestamp: "4", type: "message" },
		];
		const rows = flattenMessageTree(buildMessageTree(entries));
		expect(rows.map(r => r.node.id)).toEqual(["a", "b", "c", "d"]);
		expect(rows.map(r => r.isLast)).toEqual([true, false, true, true]);
		expect(rows.map(r => r.depth)).toEqual([0, 1, 1, 2]);
	});
});
