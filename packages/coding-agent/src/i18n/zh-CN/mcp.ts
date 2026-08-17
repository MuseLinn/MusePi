export const mcp = {
	// ── MCP / Plugins / Misc ──────────────────────────────
	"Add MCP Server": "添加 MCP 服务器",
	"stdio (Local process)": "stdio（本地进程）",
	"http (HTTP server)": "http（HTTP 服务器）",
	"sse (Server-Sent Events)": "sse（服务器推送事件）",
	"Environment variable": "环境变量",
	"HTTP header": "HTTP 头",
	"All models": "所有模型",
	Roles: "角色",
	"Switch Model": "切换模型",
	"Resume Session": "恢复会话",
	"Synthetic input": "合成输入",
	Submit: "提交",
	"Other (type your own)": "其他（输入您自己的）",
	Ask: "询问",
	Edit: "编辑",
	Preview: "预览",
	fallback: "备用",
	project: "项目",
	global: "全局",
	"no-model": "无模型",

	// ── MCP Add Wizard ────────────────────────────────────
	"Select the transport type:": "选择传输类型：",
	"Enter the command to run:": "输入要运行的命令：",
	"Enter command arguments (space-separated):": "输入命令参数（空格分隔）：",
	"Enter the server URL:": "输入服务器 URL：",
	"Enter a unique name for this server:": "输入此服务器的唯一名称：",
	"Enter the environment variable name:": "输入环境变量名称：",
	"Enter the HTTP header name:": "输入 HTTP 头名称：",
} as const;

/** Key union for the mcp domain (mirrors the desktop-web locale split). */
export type McpKey = keyof typeof mcp;
