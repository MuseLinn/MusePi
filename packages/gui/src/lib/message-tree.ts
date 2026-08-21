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

/** 从 entries 构建消息树:孤儿(无父/父缺失/自环)作为根,兄弟保持条目顺序。 */
export function buildMessageTree(entries: readonly unknown[]): MessageTreeNode[] {
	const nodes = new Map<string, MessageTreeNode>();
	const roots: MessageTreeNode[] = [];
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { id?: unknown; parentId?: unknown; timestamp?: unknown };
		if (typeof entry.id !== "string") continue;
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
