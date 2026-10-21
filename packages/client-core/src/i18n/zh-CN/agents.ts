export const agents = {
	// ── Agents ────────────────────────────────────────────────────────────────
	"agents.contextWithCount": "上下文 {count}",
	"agents.transcriptUnavailableWithReason": "无法获取记录：{reason}",
	"agents.noTranscriptAvailable": "暂无可用记录",
	"agents.messageWithName": "给 {name} 发消息…",
	"agents.tokWithCount": "{count} 令牌",
	"agents.noSubagents": "无子代理",
	"agents.main": "主代理",
	"agents.sub": "子代理",

	// ── Agents center (desktop full-page roster) ─────────────────────────────
	"agents.agentsCenter": "智能体中心",
	"agents.activity": "活动",
	"agents.lastActivity": "最近活动",
	"agents.openSessionViewAgents": "打开一个会话以查看其代理",
	"agents.runningTotalWithCountWithTotal": "{count} 运行中 · 共 {total}",
	"agents.agentsWithCount": "{count} 个代理",
	// 侧栏会话行展开名册的状态点提示。
	"agents.agentStatusRunning": "运行中",
	"agents.agentStatusIdle": "空闲",
	"agents.agentStatusParked": "已挂起",
	"agents.agentStatusAborted": "已终止",
	// Completed while the user wasn't looking — cleared on open.
	"agents.new": "新",
	// 子会话行的内嵌预览动作：在右侧面板就地停靠子代理完整会话。
	"agents.previewSubagentPanel": "在面板中预览",
	"context {count}": "上下文 {count}",
	"transcript unavailable: {reason}": "无法获取记录：{reason}",
	"no transcript available": "暂无可用记录",
	"message {name}…": "给 {name} 发消息…",
	"{count} tok": "{count} 令牌",
	"no subagents": "无子代理",
	"agents center": "智能体中心",
	"last activity": "最近活动",
	"open a session to view its agents": "打开一个会话以查看其代理",
	"{count} running · {total} total": "{count} 运行中 · 共 {total}",
	"{count} agents": "{count} 个代理",
	"agent status running": "运行中",
	"agent status idle": "空闲",
	"agent status parked": "已挂起",
	"agent status aborted": "已终止",
	"preview subagent in panel": "在面板中预览",
} as const;

/** Key union for the agents domain (source of truth). */
export type AgentsKey = keyof typeof agents;
