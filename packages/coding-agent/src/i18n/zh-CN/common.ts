export const common = {
	// ── Common ───────────────────────────────────────────────
	"common.yes": "是",
	"common.no": "否",
	"common.on": "开启",
	"common.off": "关闭",
	"common.enabled": "已启用",
	"common.disabled": "已禁用",
	"common.save": "保存",
	"common.cancel": "取消",
	"common.close": "关闭",
	"common.loading": "加载中…",
	"common.error": "错误",
	"common.warning": "警告",
	"common.success": "成功",
	"common.search": "搜索",
	"common.filter": "筛选",
	"common.clear": "清除",
	"common.copy": "复制",
	"common.paste": "粘贴",

	// ── Values ──────────────────────────────────────────────
	Apply: "应用",

	"(session default)": "（会话默认）",
	"(unset)": "（未设置）",
	"(current)": "（当前）",
	"all enabled": "全部启用",

	"one-at-a-time": "逐一",

	"(none)": "（无）",
	unknown: "未知",
	loaded: "已加载",
	"Use /agents to browse": "使用 /agents 浏览",
	"Use /agents to manage": "使用 /agents 管理",
	"Tip: Use /help to see all commands": "提示：使用 /help 查看所有命令",
} as const;

/** Key union for the common domain (mirrors the desktop-web locale split). */
export type CommonKey = keyof typeof common;
