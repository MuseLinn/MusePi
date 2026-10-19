export const mcp = {
	// ── MCP / Plugins / Misc ──────────────────────────────
	"mcp.addMcpServer": "添加 MCP 服务器",
	"mcp.stdio": "stdio（本地进程）",
	"mcp.http": "http（HTTP 服务器）",
	"mcp.sse": "sse（服务器推送事件）",
	"mcp.environmentVariable": "环境变量",
	"mcp.httpHeader": "HTTP 头",
	"mcp.allModels": "所有模型",
	"mcp.roles": "角色",
	"mcp.switchModel": "切换模型",
	"mcp.resumeSession": "恢复会话",
	"mcp.syntheticInput": "合成输入",
	"mcp.submit": "提交",
	"mcp.other": "其他（输入您自己的）",
	"mcp.tools.availableTools.ask": "询问",
	"mcp.edit": "编辑",
	"mcp.preview": "预览",
	"mcp.fallback": "备用",
	"mcp.project": "项目",
	"mcp.global": "全局",
	"mcp.noModel": "无模型",

	// ── MCP Add Wizard ────────────────────────────────────
	"mcp.selectTransportType": "选择传输类型：",
	"mcp.enterCommandRun": "输入要运行的命令：",
	"mcp.enterCommandArguments": "输入命令参数（空格分隔）：",
	"mcp.enterServerUrl": "输入服务器 URL：",
	"mcp.enterUniqueNameServer": "输入此服务器的唯一名称：",
	"mcp.enterEnvironmentVariableName": "输入环境变量名称：",
	"mcp.enterHttpHeaderName": "输入 HTTP 头名称：",
} as const;

/** Key union for the mcp domain (mirrors the guest-client locale split). */
export type McpKey = keyof typeof mcp;
