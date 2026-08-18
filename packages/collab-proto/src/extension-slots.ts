/**
 * 内核↔渲染端槽位契约(单一权威;daemon 校验 + GUI 挂载诊断共用)。
 *
 * exact = 精确槽位名;prefixes = 前缀槽位族(任意 <prefix><id> 均合法)。
 * 新增槽位先在此声明,daemon 的 extensions.list 自动下发,GUI 诊断随之可见。
 */
export const EXTENSION_SLOT_DECLARATION = {
	exact: [
		"panel.right",
		"rail.right",
		"settings.extensions",
		"composer.dock",
		"composer.left",
		"composer.right",
	] as const,
	prefixes: ["panel.tab.", "settings.tab.", "rail.", "settings.item."] as const,
} as const;
