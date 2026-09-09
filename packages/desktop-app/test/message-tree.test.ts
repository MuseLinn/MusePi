import { describe, expect, it } from "bun:test";
import { buildMessageTree, flattenMessageTree, treeToolNameOf, treeVerdictOf } from "../src/lib/message-tree";

// 消息树(/tree 语义)纯构建:entries 的 id/parentId → 分支树。

function msg(id: string, parentId: string | null, ts = 1): unknown {
	return { type: "message", id, parentId, timestamp: new Date(ts).toISOString(), message: { role: "user" } };
}

describe("buildMessageTree", () => {
	it("非 message 条目(model_change/custom)不进树", () => {
		const entries = [
			msg("a", null),
			{ type: "model_change", id: "mc1", parentId: "a", timestamp: "2026-08-17T00:00:00.000Z", model: "x/y" },
			msg("b", "a"),
		];
		const tree = buildMessageTree(entries);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.id).toBe("a");
		expect(tree[0]!.children.map(c => c.id)).toEqual(["b"]);
	});

	it("线性链:每个消息挂在父下,根 = 链头", () => {
		const tree = buildMessageTree([msg("a", null), msg("b", "a"), msg("c", "b")]);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.id).toBe("a");
		expect(tree[0]!.children.map(c => c.id)).toEqual(["b"]);
		expect(tree[0]!.children[0]!.children.map(c => c.id)).toEqual(["c"]);
	});

	it("分支:fork 产生多子;叶子有序", () => {
		const tree = buildMessageTree([msg("a", null), msg("b", "a"), msg("c", "a"), msg("d", "b")]);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.children.map(c => c.id)).toEqual(["b", "c"]);
		expect(tree[0]!.children[0]!.children.map(c => c.id)).toEqual(["d"]);
	});

	it("孤儿(父缺失/父为 null)全部成为根,保持条目顺序", () => {
		const tree = buildMessageTree([msg("x", "missing"), msg("a", null), msg("b", "a")]);
		expect(tree.map(n => n.id)).toEqual(["x", "a"]);
		expect(tree[1]!.children.map(c => c.id)).toEqual(["b"]);
	});

	it("自环(父 = 自身)按孤儿处理,不递归死循环", () => {
		const tree = buildMessageTree([msg("a", "a"), msg("b", "a")]);
		expect(tree.map(n => n.id)).toEqual(["a"]);
		expect(tree[0]!.children.map(c => c.id)).toEqual(["b"]);
	});

	it("flatten 展平:深度递增 + 兄弟末位标记", () => {
		const tree = buildMessageTree([msg("a", null), msg("b", "a"), msg("c", "a"), msg("d", "b")]);
		const rows = flattenMessageTree(tree);
		expect(rows.map(r => r.node.id)).toEqual(["a", "b", "d", "c"]);
		expect(rows.map(r => r.depth)).toEqual([0, 1, 2, 1]);
		expect(rows.map(r => r.isLast)).toEqual([true, false, true, true]);
	});

	it("空/非对象条目忽略,空输入返回空树", () => {
		expect(buildMessageTree([])).toEqual([]);
		expect(buildMessageTree([null, 42, "x"])).toEqual([]);
	});
});

describe("treeVerdictOf / treeToolNameOf(工具结果判定徽标)", () => {
	const toolResult = (opts: { isError?: boolean; content?: string; toolName?: string } = {}): unknown => ({
		type: "message",
		id: "tr1",
		parentId: null,
		timestamp: "2026-08-17T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "call1",
			toolName: opts.toolName ?? "bash",
			isError: opts.isError ?? false,
			content: [{ type: "text", text: opts.content ?? "ok" }],
		},
	});

	it("isError → error;空结果 → empty;其余 → ok", () => {
		expect(treeVerdictOf(toolResult({ isError: true }))).toBe("error");
		expect(treeVerdictOf(toolResult({ content: "" }))).toBe("empty");
		expect(treeVerdictOf(toolResult({}))).toBe("ok");
	});

	it("非 toolResult 返回 null(不画徽标)", () => {
		expect(treeVerdictOf(msg("a", null))).toBeNull();
		expect(treeVerdictOf(null)).toBeNull();
		expect(treeVerdictOf(42)).toBeNull();
	});

	it("treeToolNameOf 读 toolName,缺失/空 → null", () => {
		expect(treeToolNameOf(toolResult({ toolName: "bash" }))).toBe("bash");
		expect(treeToolNameOf(toolResult({ toolName: "" }))).toBeNull();
		expect(treeToolNameOf(msg("a", null))).toBeNull();
	});
});
