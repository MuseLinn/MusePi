/**
 * 地图/轨迹/树共用的「对话在视条目」集合 —— 一处规则,一个答案。
 *
 * 为什么要单独成模块:地图的离路径淡显必须和转录的排除集是同一个答案。之前
 * `trustedPathIds` 交出去的是 walk/pin 的**原始** id 集,而转录实际用
 * `filterVisibleEntries` 过滤,后者还会套上 daemon 只回 200 条的窗口边界
 * (`packages/coding-agent` 的 `TAIL_ENTRIES`)。于是同一份会话,转录说「这是
 * 历史」,地图说「这是旁支」——两个界面各答各的:
 *
 *  - 尾部 parentId 全为 null 的形态:walk 把整条 live 会话读成一条从假根起的
 *    路径,原始 id 集只含尾部少数条目,地图把其余全部涂成支线;
 *  - 截断 walk + 已加载 ~260 行:pin 的路径只有最后 200 条,地图把第 1-30 轮
 *    (转录照常显示的历史)判成离路径。
 *
 * 修法(评审建议的形态):**不再让第二处独立理解窗口**——转录算完自己的可见
 * 条目后,把结果里那批 id 直接交给地图。转录显示什么,地图就认什么为主线。
 *
 * 注意这里回答的是「在不在对话里」,不是「我在哪」:当前位置(leaf 链)是另一个
 * 问题,由 `leafPath` 回答,消息树的当前位置高亮继续用它。
 */

/**
 * 从「已过滤的可见条目」投影出 id 集。没有 id 的条目(轮标记、合成行)不进
 * 集合:它们不参与分支判定(`isBranchEntry` 只对有 id 的条目发问),进集合只会
 * 让 size 变得不可比较。
 */
export function visibleEntryIds(entries: readonly unknown[]): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const id = (entry as { id?: unknown }).id;
		if (typeof id === "string") ids.add(id);
	}
	return ids;
}

/**
 * 交给地图/轨迹的「对话在视」集合。
 *
 * 契约:返回的集合就是转录此刻显示的那批 id。由此
 *  - 转录排除的条目不在集合里 → 地图把它画成离路径;
 *  - 转录什么都没排除(拓扑不可信时的全显示、或线性会话)→ 集合含全部 id →
 *    没有任何轮被判成旁支,地图画一条主线。这正是该情形下的诚实答案,不需要
 *    另设「null = 不知道」的分支。
 *
 * 无条目时返回 `null`:没有会话就没有路径,调用方退回 leaf 高亮。
 */
export function transcriptPathIds(
	entries: readonly unknown[],
	visible: readonly unknown[],
): ReadonlySet<string> | null {
	if (entries.length === 0) return null;
	return visibleEntryIds(visible);
}
