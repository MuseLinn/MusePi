export const agents = {
	// ── Agents ────────────────────────────────────────────────────────────────
	"context {count}": "上下文 {count}",
	"transcript unavailable: {reason}": "无法获取记录：{reason}",
	"no transcript available": "暂无可用记录",
	"message {name}…": "给 {name} 发消息…",
	"{count} tok": "{count} 令牌",
	"no subagents": "无子代理",
	main: "主代理",
	sub: "子代理",

	// ── Agents center (desktop full-page roster) ─────────────────────────────
	"agents center": "智能体中心",
	activity: "活动",
	"last activity": "最近活动",
	"open a session to view its agents": "打开一个会话以查看其代理",
	"{count} running · {total} total": "{count} 运行中 · 共 {total}",
	"{count} agents": "{count} 个代理",
} as const;

/** Key union for the agents domain (source of truth). */
export type AgentsKey = keyof typeof agents;
