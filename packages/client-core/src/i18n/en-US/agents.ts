import type { AgentsKey } from "../zh-CN/agents.js";

export const agents = {
	// ── Agents ────────────────────────────────────────────────────────────────
	"context {count}": "Context {count}",
	"transcript unavailable: {reason}": "Transcript unavailable: {reason}",
	"no transcript available": "No transcript available",
	"message {name}…": "Message {name}…",
	"{count} tok": "{count} tok",
	"no subagents": "No subagents",
	main: "Main",
	sub: "Sub",

	// ── Agents center (desktop full-page roster) ─────────────────────────────
	"agents center": "Agents Center",
	activity: "Activity",
	"last activity": "Last activity",
	"open a session to view its agents": "Open a session to view its agents",
	"{count} running · {total} total": "{count} running · {total} total",
	"{count} agents": "{count} agents",
	// 侧栏会话行展开名册的状态点提示。
	"agent status running": "Running",
	"agent status idle": "Idle",
	"agent status parked": "Parked",
	"agent status aborted": "Aborted",
	// Completed while the user wasn't looking — cleared on open.
	new: "New",
	// Sub-session row action: dock the subagent's full conversation over the panel.
	"preview subagent in panel": "Preview in panel",
} as const satisfies Record<AgentsKey, string>;
