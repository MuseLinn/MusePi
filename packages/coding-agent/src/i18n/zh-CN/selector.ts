export const selector = {
	// ── Settings Selector ──────────────────────────────────
	"  Enter to save · Esc to cancel · Clear field to unset": "  Enter: 保存 · Esc: 取消 · 清空以取消设置",
	"  Enter to select · Esc to go back": "  Enter: 选择 · Esc: 返回",
	"Preview:": "预览:",

	// ── Plan Review Overlay ───────────────────────────────
	"Plan Review": "计划审查",
	"esc cancel": "Esc 取消",
	"enter save": "Enter 保存",
	"Refinement feedback on the plan:\n": "对计划的优化反馈:\n",

	// ── Session / Tree selector ────────────────────────────
	"No sessions found": "未找到会话",
	"No entries found": "未找到条目",
	"No matching models": "没有匹配的模型",
	"No matching history entries": "没有匹配的历史记录",
	"No providers": "没有提供商",
	"No resources found": "未找到资源",
	"No user messages found": "未找到用户消息",
	"No servers configured.": "未配置服务器",
	"Session Tree": "会话树",
	"assistant: ": "助手: ",
	"user: ": "用户: ",
	"(aborted)": "（已中止）",
	"(cancelled)": "（已取消）",
	"(cleared)": "（已清除）",
	"(no content)": "（无内容）",
	"branch summary": "分支摘要",
	"Cannot delete the currently active session": "无法删除当前活跃会话",
	All: "全部",
	"Current Folder": "当前文件夹",

	// ── Config-selector ─────────────────────────────────────
	"project load": "项目加载",
	"project unload": "项目卸载",
	"inherited global": "继承的全局配置",
	" · inherited global": " · 继承的全局配置",
	"[x]": "[x]",
} as const;

/** Key union for the selector domain (mirrors the desktop-web locale split). */
export type SelectorKey = keyof typeof selector;
