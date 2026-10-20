import type { AgentsKey } from "../zh-CN/agents.js";

export const agents = {
	// ── Agents ────────────────────────────────────────────────────────────────
	"agents.contextWithCount": "Context {count}",
	"agents.transcriptUnavailableWithReason": "Transcript unavailable: {reason}",
	"agents.noTranscriptAvailable": "No transcript available",
	"agents.messageWithName": "Message {name}…",
	"agents.tokWithCount": "{count} tok",
	"agents.noSubagents": "No subagents",
	"agents.main": "Main",
	"agents.sub": "Sub",

	// ── Agents center (desktop full-page roster) ─────────────────────────────
	"agents.agentsCenter": "Agents Center",
	"agents.activity": "Activity",
	"agents.lastActivity": "Last activity",
	"agents.openSessionViewAgents": "Open a session to view its agents",
	"agents.runningTotalWithCountWithTotal": "{count} running · {total} total",
	"agents.agentsWithCount": "{count} agents",
	// 侧栏会话行展开名册的状态点提示。
	"agents.agentStatusRunning": "Running",
	"agents.agentStatusIdle": "Idle",
	"agents.agentStatusParked": "Parked",
	"agents.agentStatusAborted": "Aborted",
	// Completed while the user wasn't looking — cleared on open.
	"agents.new": "New",
	// Sub-session row action: dock the subagent's full conversation over the panel.
	"agents.previewSubagentPanel": "Preview in panel",	"context {count}": "context {count}",
	"transcript unavailable: {reason}": "transcript unavailable: {reason}",
	"no transcript available": "no transcript available",
	"message {name}…": "message {name}…",
	"{count} tok": "{count} tok",
	"no subagents": "no subagents",
	"agents center": "agents center",
	"last activity": "last activity",
	"open a session to view its agents": "open a session to view its agents",
	"{count} running · {total} total": "{count} running · {total} total",
	"{count} agents": "{count} agents",
	"agent status running": "agent status running",
	"agent status idle": "agent status idle",
	"agent status parked": "agent status parked",
	"agent status aborted": "agent status aborted",
	"preview subagent in panel": "preview subagent in panel",

} as const satisfies Record<AgentsKey, string>;
