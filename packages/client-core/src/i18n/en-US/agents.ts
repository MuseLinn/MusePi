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
	"agents.previewSubagentPanel": "Preview in panel",
} as const satisfies Record<AgentsKey, string>;
