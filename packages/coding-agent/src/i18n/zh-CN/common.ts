export const common = {
	// ── Common ───────────────────────────────────────────────
	// The approval dialog's two answers. Keys are the English source text, so the
	// same dialog reads correctly in either language without a second key set.
	Approve: "批准",
	Deny: "拒绝",
	// Approval prompt labels. The value after each colon is data (a tool name, a
	// command, a reason) and is never translated.
	"Allow tool": "允许工具",
	// Detail-line labels the tools emit (`Command: …`, `File: …`); only the label
	// is translated, the value after the colon is data.
	Command: "命令",
	File: "文件",
	Action: "操作",
	Agent: "子智能体",
	Name: "名称",
	Task: "任务",
	Path: "路径",
	Query: "查询",
	Tool: "工具",
	URL: "地址",
	Server: "服务器",
	Reason: "原因",
	"Origin: MCP server tool": "来源：MCP 服务器工具",
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
	"common.tipUseHelp.info": "提示：使用 /help 查看所有命令",
	"(session default)": "（会话默认）",
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
