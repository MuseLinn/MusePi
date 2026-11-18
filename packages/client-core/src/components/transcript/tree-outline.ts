/**
 * 会话树拓扑的纯派生:根→叶路径、每个节点的子节点数、当前叶是否历史节点。
 *
 * 叶子由调用方给出:`tip` 跟随会话尖端(最后追加的条目),`root` 表示停在
 * 会话根(撤回首条用户消息后的状态),`node` 是 `session.branchAt` /
 * `session.regenerateAt` 返回的 leafId —— 树操作只移动 leaf 指针、不追加
 * 条目,仅靠"最后一个条目"无法观察到当前位置。
 *
 * 链断(parentId 指向窗口外,或中段出现漏打 parentId 的条目)时 `complete`
 * 为 false:路径仍可展示,但它只是窗口内的残段,调用方不得据此裁剪转录。
 * 头部连续 root 级条目(会话序言与首条消息同挂根)是可信根,与中段缺失
 * 区分开 —— 判据与桌面端 leaf-walk 一致。
 */
import type { SessionEntry } from "@musepi/pi-wire";
import { isBranchFormingEntry, msgText, readLiveCustomMessage } from "./transcript-content";

/** 面包屑与提示的标签上限(字符);超出截断,完整文本留在 title 上。 */
const LABEL_MAX = 60;

/** 当前叶的位置来源。 */
export type TreeLeaf = { mode: "tip" } | { mode: "root" } | { mode: "node"; id: string };

export interface TreeOutlineNode {
	id: string;
	/** message 的 role,否则是条目 type —— 面包屑据此上色。 */
	kind: string;
	/** 人读标签(首段文本),无文本时为空串。 */
	label: string;
}

export interface TreeOutline {
	/** 根→叶,最旧在前;空数组 = 会话根或空会话。 */
	path: TreeOutlineNode[];
	/** 是否走到可信根。false = 路径是窗口内残段。 */
	complete: boolean;
	/** 每个节点的直接子节点数(只计会话分叉 message)。 */
	childCount: ReadonlyMap<string, number>;
	/** 当前叶 id;root 模式或空会话为 null。 */
	leafId: string | null;
	/** 当前叶已有子节点 —— 此时发送会创建新分支。 */
	leafIsHistorical: boolean;
	/** 当前叶的人读标签,无叶时为空串。 */
	leafLabel: string;
}

function clip(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
}

function labelOf(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "toolResult") return message.toolName ?? "toolResult";
		// bashExecution 没有 content 字段,它的可读文本是命令行本身。
		if (message.role === "bashExecution") return clip(message.command);
		const custom = readLiveCustomMessage(message);
		if (custom) return custom.customType;
		return clip(msgText(message));
	}
	if (entry.type === "custom_message") return entry.customType;
	return entry.type;
}

function kindOf(entry: SessionEntry): string {
	return entry.type === "message" ? entry.message.role : entry.type;
}

export function deriveTreeOutline(entries: readonly SessionEntry[], leaf: TreeLeaf): TreeOutline {
	const byId = new Map<string, SessionEntry>();
	const childCount = new Map<string, number>();
	// 分叉只算普通消息:custom 展示卡(顾问/IRC/async 结果)与簿记条目
	// 不计入,否则同父的卡与消息会凭空凑出一条"2 个分支"。
	for (const entry of entries) {
		byId.set(entry.id, entry);
		if (!isBranchFormingEntry(entry)) continue;
		const parentId = entry.parentId;
		if (!parentId) continue;
		childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
	}
	const rootRun = new Set<string>();
	for (const entry of entries) {
		if (entry.parentId) break;
		rootRun.add(entry.id);
	}

	const tipId = entries.length > 0 ? (entries[entries.length - 1] as SessionEntry).id : null;
	// 显式 leaf 落在窗口外(重连后被截断的历史,或会话已切换)时退回尖端:
	// 空白面包屑读起来像"树没了",而尖端至少还是当前可见的那条路径。
	const pinnedId = leaf.mode === "node" && byId.has(leaf.id) ? leaf.id : null;
	const leafId = leaf.mode === "root" ? null : (pinnedId ?? tipId);

	const path: TreeOutlineNode[] = [];
	let complete = leaf.mode === "root";
	if (leafId !== null) {
		const seen = new Set<string>();
		let cursor: string | null = leafId;
		while (cursor !== null && !seen.has(cursor)) {
			seen.add(cursor);
			const entry = byId.get(cursor);
			if (!entry) break;
			path.unshift({ id: entry.id, kind: kindOf(entry), label: labelOf(entry) });
			if (!entry.parentId) {
				complete = rootRun.has(entry.id);
				break;
			}
			if (!byId.has(entry.parentId)) break;
			cursor = entry.parentId;
		}
	}

	const leafEntry = leafId !== null ? byId.get(leafId) : undefined;
	return {
		path,
		complete,
		childCount,
		leafId,
		leafIsHistorical: leafId !== null && (childCount.get(leafId) ?? 0) > 0,
		leafLabel:
			path.length > 0 ? (path[path.length - 1] as TreeOutlineNode).label : leafEntry ? labelOf(leafEntry) : "",
	};
}

/**
 * 面包屑是否值得出现。
 *
 * 线性会话里"根→叶"就是转录本身,再列一遍只是把同样的文字重排在顶上;
 * 只有出现分支点或当前叶是历史节点时,面包屑才回答一个转录答不了的问题
 * —— 我在树的哪里、还有哪些兄弟分支。链断(`complete` 为 false)时路径
 * 只是窗口内的残段,但分支点仍可能在其中,所以不因此隐藏,由渲染层在
 * 链首补省略号说明它上面还有内容。
 */
export function shouldShowTreeNav(outline: TreeOutline): boolean {
	if (outline.path.length === 0) return false;
	if (outline.leafIsHistorical) return true;
	for (const count of outline.childCount.values()) if (count > 1) return true;
	return false;
}
