export const common = {
	// ── Common ───────────────────────────────────────────────
	"common.commonYes": "是",
	"common.commonNo": "否",
	"common.commonOn": "开启",
	"common.commonOff": "关闭",
	"common.commonEnabled": "已启用",
	"common.commonDisabled": "已禁用",
	"common.commonSave": "保存",
	"common.commonCancel": "取消",
	"common.commonClose": "关闭",
	"common.commonLoading": "加载中…",
	"common.commonError": "错误",
	"common.commonWarning": "警告",
	"common.commonSuccess": "成功",
	"common.commonSearch": "搜索",
	"common.commonFilter": "筛选",
	"common.commonClear": "清除",
	"common.commonCopy": "复制",
	"common.commonPaste": "粘贴",

	// ── Values ──────────────────────────────────────────────
	"common.apply": "应用",

	"common.text": "（会话默认）",
	"common.text2": "（未设置）",
	"common.text3": "（当前）",
	"common.allEnabled": "全部启用",

	"common.oneTime": "逐一",

	"common.text4": "（无）",
	"common.unknown": "未知",
	"common.loaded": "已加载",
	"common.useAgentsBrowse": "使用 /agents 浏览",
	"common.useAgentsManage": "使用 /agents 管理",
	"common.tipUseHelp.info": "提示：使用 /help 查看所有命令",	"(session default)": "（会话默认）",
	"(unset)": "（未设置）",
	"(current)": "（当前）",
	"all enabled": "全部启用",
	"one-at-a-time": "逐一",
	"(none)": "（无）",
	"Use /agents to browse": "使用 /agents 浏览",
	"Use /agents to manage": "使用 /agents 管理",
	"Tip: Use /help to see all commands": "提示：使用 /help 查看所有命令",

} as const;

/** Key union for the common domain (mirrors the guest-client locale split). */
export type CommonKey = keyof typeof common;
