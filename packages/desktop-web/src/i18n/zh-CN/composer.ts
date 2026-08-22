export const composer = {
	// ── Composer ──────────────────────────────────────────────────────────────
	"type your response…": "输入您的回复…",
	"read-only session — watching only": "只读会话 — 仅观看",
	"prompt the host agent…": "向宿主代理发送提示…",
	"waiting for session…": "等待会话…",
	"submit response": "提交回复",
	"send (Enter)": "发送（回车）",
	"working active": "工作中",
	"stop turn": "停止",
	"stop the current turn": "停止当前回合",
	"compact context": "压缩上下文",
	"compacting…": "压缩中…",
	"stop compaction": "停止压缩",
	"compaction failed": "压缩失败",
	"retry last turn": "重试上一轮",
	"nothing to retry": "无可重试",
	"mark in progress": "标记进行中",
	"abandon task": "放弃任务",
	"remove task": "删除任务",
	"add a task…": "添加任务…",
	"view-only": "仅查看",

	// ── Ask editor ────────────────────────────────────────────────────────────
	"(Recommended)": "（推荐）",
	recommended: "推荐",
	multi: "多选",
	"no selection": "未选择",
	"auto-selected after timeout — not a user choice": "超时后自动选择 — 非用户选择",

	// ── Slash commands (composer / TUI parity) ─────────────────────────
	"unknown slash command": "未知命令",
	"this command only works in the terminal": "该命令仅在终端中可用",
	"skill not found": "未找到该技能",
	"slash command failed": "命令执行失败",
	// ── Bash commands (! / !! composer, TUI parity) ────────────────────
	"bash command failed": "命令执行失败",
	"bash command cancelled": "命令已取消",
	"bash exited with code {code} ({lines} lines)": "命令以退出码 {code} 结束（{lines} 行输出）",
	"bash output excluded from context": "输出已从上下文排除",
	cancelled: "已取消",
	"show all": "显示全部",
	lines: "行",
} as const;

/** Key union for the composer domain (source of truth). */
export type ComposerKey = keyof typeof composer;
