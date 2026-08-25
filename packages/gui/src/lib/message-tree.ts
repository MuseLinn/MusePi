/**
 * 消息树(/tree 语义,会话内条目树)纯构建:从 snap.entries 的 id/parentId
 * 建父子分支树。历史/持久化快照自带 parentId(立即可用);live 会话的
 * parentId 依赖 wire 发射端打标(live 消息树 seam,见 docs/gui-implementation.md)。
 *
 * 与右侧轨迹面板(TurnRail/事件时间线)的关系:轨迹按 **时间/turn** 投影,
 * 消息树按 **分支结构(parentId)** 投影——同一棵 entry 树的两个轴,对应
 * TUI 的 /tree(结构)与 /trace(轨迹)之分。GUI 轨迹面板未来加"时间线/分支树"
 * 切换时复用此构建器。
 */
export interface MessageTreeNode {
	id: string;
	parentId: string | null;
	timestamp: string;
	/** 原始 entry(MessageEntry 等 SessionEntry 子集,透传不整存)。 */
	entry: unknown;
	children: MessageTreeNode[];
}

/** 展平后的树行(渲染视图用;isLast 供缩进连接线/脊柱绘制)。 */
export interface FlatMessageTreeRow {
	node: MessageTreeNode;
	depth: number;
	isLast: boolean;
}

/**
 * 从 entries 构建消息树:孤儿(无父/父缺失/自环)作为根,兄弟保持条目顺序。
 * 只收 message 条目(画布/分支树的节点 = 消息摘要,边 = parent-child 消息
 * 流;model_change/custom/thinking_level_change 等非消息条目不进树——
 * 它们是轨迹时间线的事件,不是消息流节点。daemon 侧已把消息的 parentId
 * 归一为「最近消息祖先」的 view key,这里无需再走链)。
 */
export function buildMessageTree(entries: readonly unknown[]): MessageTreeNode[] {
	const nodes = new Map<string, MessageTreeNode>();
	const roots: MessageTreeNode[] = [];
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { id?: unknown; parentId?: unknown; timestamp?: unknown; type?: unknown };
		if (typeof entry.id !== "string") continue;
		if (entry.type !== "message") continue;
		const node: MessageTreeNode = {
			id: entry.id,
			parentId: entry.parentId === null || typeof entry.parentId !== "string" ? null : entry.parentId,
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
			entry: raw,
			children: [],
		};
		nodes.set(entry.id, node);
	}
	for (const node of nodes.values()) {
		if (node.parentId !== null && node.parentId !== node.id) {
			const parent = nodes.get(node.parentId);
			if (parent) {
				parent.children.push(node);
				continue;
			}
		}
		roots.push(node);
	}
	return roots;
}

export function flattenMessageTree(roots: readonly MessageTreeNode[]): FlatMessageTreeRow[] {
	const rows: FlatMessageTreeRow[] = [];
	const walk = (nodes: readonly MessageTreeNode[], depth: number): void => {
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			rows.push({ node, depth, isLast: i === nodes.length - 1 });
			if (node.children.length > 0) walk(node.children, depth + 1);
		}
	};
	walk(roots, 0);
	return rows;
}

/** 树行 kind 提取(message 条目按 role;其余条目归为 other)。 */
export function treeKindOf(entry: unknown): "user" | "assistant" | "toolResult" | "other" {
	if (!entry || typeof entry !== "object") return "other";
	const e = entry as { type?: unknown; message?: { role?: unknown } };
	if (e.type === "message") {
		const role = e.message?.role;
		if (role === "user") return "user";
		if (role === "toolResult") return "toolResult";
		return "assistant";
	}
	return "other";
}

/** 树行文本预览:message content 块拼接纯文本;非消息条目显示类型名。 */
export function treeTextOf(entry: unknown): string {
	if (!entry || typeof entry !== "object") return "…";
	const e = entry as { type?: unknown; message?: { content?: unknown; text?: unknown } };
	if (e.type === "message") {
		const m = e.message;
		const blocks = Array.isArray(m?.content) ? (m.content as Array<{ type?: string; text?: string }>) : [];
		const text =
			typeof m?.content === "string"
				? m.content
				: typeof m?.text === "string"
					? m.text
					: blocks.filter(b => b?.type === "text").map(b => b.text ?? "").join(" ");
		return text.replace(/\s+/g, " ").trim().slice(0, 90) || "…";
	}
	return typeof e.type === "string" ? e.type : "entry";
}

/** 树节点 kind → oc-icons 名(轨迹树行/地图画布共用)。 */
export const TREE_ICON: Record<string, string> = {
	user: "user",
	toolResult: "hammer",
	assistant: "sparkling",
	other: "file-list-2",
};
