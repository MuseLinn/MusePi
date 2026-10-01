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

/**
 * 概览面(轨迹/地图/分支树)条目文本上限。所有概览消费方的显示截断
 * (轨迹 80/120/220/160、树行预览)都 ≤ 这个值,所以摄入时按此上限
 * 预截断任一文本字段对显示输出是恒等的(join 后截断只依赖前缀)。
 */
export const OVERVIEW_TEXT_CAP = 400;

function capText(s: string): string {
	return s.length > OVERVIEW_TEXT_CAP ? `${s.slice(0, OVERVIEW_TEXT_CAP)}…` : s;
}

/**
 * 概览专用轻量条目(P0-4):会话全量补全(ensureFullHistory)会把每条
 * SessionEntry 原文存进第二份本地数组——长会话下这是数百 MB 的重复
 * 内容,而概览消费方只读显示级文本(≤ OVERVIEW_TEXT_CAP)与结构字段
 * (id/parentId/type/timestamp/usage/duration)。浅拷贝并裁掉重负载:
 * 文本块预截断、图片块剥掉 data(概览从不渲染图片)、顾问 notes 预截断。
 * 结构字段原样保留,树/轨迹构建输出与原文条目共价。
 */
export function lightenOverviewEntry(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const entry = raw as Record<string, unknown>;
	const out: Record<string, unknown> = { ...entry };
	const msg = entry.message;
	if (msg !== null && typeof msg === "object") {
		const m = msg as Record<string, unknown>;
		const light: Record<string, unknown> = { ...m };
		if (typeof m.content === "string") {
			light.content = capText(m.content);
		} else if (Array.isArray(m.content)) {
			light.content = m.content.map(block => {
				if (!block || typeof block !== "object") return block;
				const b = block as Record<string, unknown>;
				if (typeof b.text === "string" && b.text.length > OVERVIEW_TEXT_CAP) {
					return { ...b, text: capText(b.text) };
				}
				if (typeof b.thinking === "string" && b.thinking.length > OVERVIEW_TEXT_CAP) {
					return { ...b, thinking: capText(b.thinking) };
				}
				// 图片块:data(base64)可达数 MB,概览消费方从不读取——剥掉。
				if (b.type === "image" && ("data" in b || "mimeType" in b)) {
					const { data: _d, mimeType: _m, ...rest } = b;
					return rest;
				}
				return block;
			});
		}
		if (typeof m.text === "string" && m.text.length > OVERVIEW_TEXT_CAP) light.text = capText(m.text);
		if (typeof m.result === "string" && m.result.length > OVERVIEW_TEXT_CAP) {
			light.result = capText(m.result);
		}
		out.message = light;
	}
	const details = entry.details;
	if (details !== null && typeof details === "object") {
		const d = details as Record<string, unknown>;
		if (Array.isArray(d.notes)) {
			out.details = {
				...d,
				notes: d.notes.map(n => {
					if (n && typeof n === "object" && typeof (n as { note?: unknown }).note === "string") {
						const note = n as { note: string };
						return note.note.length > OVERVIEW_TEXT_CAP ? { ...note, note: capText(note.note) } : n;
					}
					return n;
				}),
			};
		}
	}
	if (typeof entry.content === "string" && entry.content.length > OVERVIEW_TEXT_CAP) {
		out.content = capText(entry.content);
	}
	return out;
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
	// Iterative pre-order: a long linear session builds a parent→child chain
	// thousands deep (one node per message), and the recursive walk overflowed
	// the call stack (RangeError) once session.history paging loaded the full
	// transcript into the trajectory/canvas views.
	const stack: { node: MessageTreeNode; depth: number; isLast: boolean }[] = [];
	for (let i = roots.length - 1; i >= 0; i--) {
		stack.push({ node: roots[i]!, depth: 0, isLast: i === roots.length - 1 });
	}
	while (stack.length > 0) {
		const { node, depth, isLast } = stack.pop()!;
		rows.push({ node, depth, isLast });
		const children = node.children;
		for (let i = children.length - 1; i >= 0; i--) {
			stack.push({ node: children[i]!, depth: depth + 1, isLast: i === children.length - 1 });
		}
	}
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

/** 树行文本预览:message content 块拼接纯文本;工具调用行无文本块时回退到
 *  工具名汇总;空工具结果返回 ""(行渲染层可用 treeToolNameOf 兜底);
 *  视觉截断交给 .traj-trow-text 的 CSS ellipsis,这里只留 DOM 上限,不再
 *  预切片加 "…"(预切片会让每行都自带硬截断点,工具行整行读作省略号)。 */
export function treeTextOf(entry: unknown): string {
	if (!entry || typeof entry !== "object") return "…";
	const e = entry as {
		type?: unknown;
		message?: { role?: unknown; content?: unknown; text?: unknown };
	};
	if (e.type === "message") {
		const m = e.message;
		const blocks = Array.isArray(m?.content) ? (m.content as Array<{ type?: string; text?: string }>) : [];
		const text =
			typeof m?.content === "string"
				? m.content
				: typeof m?.text === "string"
					? m.text
					: blocks
							.filter(b => b?.type === "text")
							.map(b => b.text ?? "")
							.join(" ");
		const cleaned = text.replace(/\s+/g, " ").trim();
		if (cleaned) return cleaned.slice(0, OVERVIEW_TEXT_CAP);
		if (m?.role === "toolResult") return "";
		const calls = blocks.filter(b => b?.type === "toolCall") as Array<{ name?: string }>;
		if (calls.length > 0) {
			const names = calls.map(c => (typeof c.name === "string" && c.name !== "" ? c.name : "?"));
			return names.length === 1 ? names[0]! : `${names[0]!} +${names.length - 1}`;
		}
		return "…";
	}
	return typeof e.type === "string" ? e.type : "entry";
}

/** 工具结果节点判定(dsh-maze verdict 的减化诚实版):只读 wire `isError`
 *  + 结果文本是否为空,不按输出长度/特征猜测——空结果(检索扑空)与失败
 *  (isError)分开,非工具结果返回 null(不画徽标)。 */
export type ToolVerdict = "ok" | "error" | "empty";
export function treeVerdictOf(entry: unknown): ToolVerdict | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as { type?: unknown; message?: { role?: unknown; isError?: unknown; content?: unknown } };
	if (e.type !== "message" || e.message?.role !== "toolResult") return null;
	if (e.message.isError === true) return "error";
	const text = treeTextOf(entry);
	return text === "" || text === "…" ? "empty" : "ok";
}

/** 工具结果节点对应的工具名(wire ToolResultMessage.toolName;缺失回退 null)。 */
export function treeToolNameOf(entry: unknown): string | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as { type?: unknown; message?: { role?: unknown; toolName?: unknown } };
	if (e.type !== "message" || e.message?.role !== "toolResult") return null;
	return typeof e.message.toolName === "string" && e.message.toolName !== "" ? e.message.toolName : null;
}
export const TREE_ICON: Record<string, string> = {
	user: "user",
	toolResult: "hammer",
	assistant: "sparkling",
	other: "file-list-2",
};
