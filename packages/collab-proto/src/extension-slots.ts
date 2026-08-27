/**
 * 内核↔渲染端槽位契约(单一权威;daemon 校验 + GUI 挂载诊断共用)。
 *
 * exact = 精确槽位名;prefixes = 前缀槽位族(任意 <prefix><id> 均合法)。
 * 新增槽位先在此声明,daemon 的 extensions.list 自动下发,GUI 诊断随之可见。
 *
 * transcript.node —— DSH 粒度(对应 DSH `conversation.chat.node`):单一
 * “聊天节点 seat”槽,按节点 kind(entryKey)分发;turn-tail / tool / user /
 * assistant 都是该 seat 的节点 kind,而非独立槽。宿主(渲染器)按 kind
 * 派发到注册的渲染器,无注册时回退到内建渲染(fallback)。
 */
export const EXTENSION_SLOT_DECLARATION = {
	exact: [
		"panel.right",
		"rail.right",
		"settings.extensions",
		"composer.dock",
		"composer.left",
		"composer.right",
		"transcript.node",
	] as const,
	prefixes: ["panel.tab.", "settings.tab.", "rail.", "settings.item.", "settings.action."] as const,
} as const;
