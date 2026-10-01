/**
 * ChatView 活跃路径推导(纯逻辑,组件与测试共用)。
 *
 * 从尾条目沿 parentId 链走根→叶(breadcrumb path)。`complete` 记录 walk
 * 为何停下:
 * - 到达真根(parentless 且是加载窗内最老条目)→ 拓扑可信;
 * - 任何其他停止方式(parentId 指向窗外、链上缺节点、parentless 但不是
 *   最老条目)→ 链断,拓扑不可信。
 *
 * 链断与真根的区分是 transcript 可见性的闸门:complete=false 时过滤层
 * 必须回退"全显示"(不能把旧消息藏掉);complete=true 才按活跃路径过滤。
 * 实机回归(2026-09-27):某 role(顾问卡 custom)漏打 parentId,尾卡片
 * parentless 被误判真根 → 活跃路径只剩它一行,旧消息整批消失。
 */

export interface LeafWalkNode {
	id: string;
	kind: string;
}

export interface LeafWalk {
	path: LeafWalkNode[];
	complete: boolean;
}

/** 空路径且可信 —— 被 pin 到会话根(rewind 过第一条 user 消息)时用。 */
export const EMPTY_TRUSTED_WALK: LeafWalk = { path: [], complete: true };

export function walkLeafPath<T>(entries: readonly T[], leafId: string | null): LeafWalk {
	const byId = new Map<string, LeafWalkNode>();
	const byKey = new Map<string, { id?: unknown; parentId?: unknown; type?: string }>();
	for (const entry of entries) {
		const e = entry as { id?: string; type?: string; message?: { role?: string } };
		if (typeof e.id !== "string") continue;
		byId.set(e.id, {
			id: e.id,
			kind: e.type === "message" ? (e.message?.role ?? "message") : (e.type ?? "entry"),
		});
		byKey.set(e.id, e);
	}
	// 头部 root 级连续段:从首条目起连续的 parentless 条目(会话序言的
	// model_change/thinking_level_change 与第一条 user 消息同挂会话根)。
	// 走到其中任一 parentless 节点都算到达真根;窗口中段的 parentless
	// 节点(发射端漏打 parentId,2026-09-27 顾问卡回归)不在该段内,
	// 仍判链断。实机回归(2026-10-01,会话 01a0f81b):序言条目使首条
	// user 消息不是"最老条目",旧 `cursor === oldestId` 判据把完整链误判
	// 链断 → 活跃路径过滤整段失效,撤回后的旧分支全部留在转录里。
	const rootRunIds = new Set<string>();
	for (const entry of entries) {
		const e = entry as { id?: unknown; parentId?: unknown };
		if (typeof e.id !== "string" || typeof e.parentId === "string") break;
		rootRunIds.add(e.id);
	}
	const path: LeafWalkNode[] = [];
	const seen = new Set<string>();
	let cursor = leafId;
	let complete = false;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const node = byId.get(cursor);
		if (!node) break; // leaf/parent outside the window → chain cut
		path.unshift(node);
		const entry = byKey.get(cursor);
		const parent = entry?.parentId;
		if (typeof parent !== "string") {
			// parentless:真根仅当它属于头部 root 级连续段(序言同根的
			// 首条消息);否则某条消息的 parentId 缺失(发射端漏打),链
			// 在这里断掉。
			complete = rootRunIds.has(cursor);
			break;
		}
		if (!byKey.has(parent)) break; // next hop is missing → chain cut
		cursor = parent;
	}
	return { path, complete };
}

/**
 * Transcript 可见集:活跃路径过滤。
 *
 * complete=false(拓扑不可信)时绝不藏行 —— 除非 daemon 随本次移动捎来
 * 权威活跃路径(pinnedPathIds,长会话 rewind 的存活路径,它不受加载窗
 * 限制)。complete=true 时按活跃路径过滤;pin 到会话根时第一条 user
 * 消息是 rewind 越过的节点,必须离开 transcript。无父链的条目(轮标记、
 * 合成行)挂在会话根上,永远保留(pinnedToRoot 时的 user 消息除外)。
 */
export function filterVisibleEntries<T>(
	entries: readonly T[],
	walk: LeafWalk,
	activePathIds: ReadonlySet<string>,
	opts: { pinnedPathIds?: ReadonlySet<string>; pinnedToRoot: boolean },
): T[] {
	if (!walk.complete) {
		const pinned = opts.pinnedPathIds;
		if (!pinned) return [...entries];
		return entries.filter(entry => {
			const e = entry as { id?: unknown; parentId?: unknown; type?: string };
			if (typeof e.id !== "string") return true;
			if (typeof e.parentId !== "string") {
				return e.type !== "message" || pinned.has(e.id);
			}
			return pinned.has(e.id);
		});
	}
	return entries.filter(entry => {
		const e = entry as { id?: unknown; parentId?: unknown; type?: string };
		if (typeof e.id !== "string") return true;
		if (typeof e.parentId !== "string") {
			if (opts.pinnedToRoot && e.type === "message") return false;
			return true;
		}
		return activePathIds.has(e.id);
	});
}
