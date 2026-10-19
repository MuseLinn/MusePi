import type { ShellKey } from "../zh-CN/shell.js";

export const shell = {
	// ── Connect screen ────────────────────────────────────────────────────────
	"shell.musepiCollab": "MusePi Collab",
	"shell.liveAgentSession.info": "Live agent session, in your browser",
	"shell.joinLink": "Join link",
	"shell.displayName": "Display name",
	"shell.pasteJoinLinkFirst": "Paste a join link first",
	"shell.pasteCollabLinkAny": "Paste a /collab link from any musepi session",
	"shell.wsHostPortR": "ws://host:port/r/room.key",

	// ── Header bar ────────────────────────────────────────────────────────────
	"shell.readOnly": "Read-only",
	"shell.readOnlyLinkWatching": "Read-only link — watching only",
	"shell.contextWithPct": "Context · {pct}",
	"shell.hideAgents": "Hide agents",
	"shell.showAgents": "Show agents",
	"shell.leaveSession": "Leave session",
	"shell.connectingRelay": "Connecting to relay…",
	"shell.joiningSession": "Joining session…",
	"shell.reconnecting": "Reconnecting…",
	"shell.sessionEnded": "Session ended",
	"shell.showMainWindow": "Show main window",
	"shell.quit": "Quit",
	"shell.newLink": "New link",

	// ── Banners ───────────────────────────────────────────────────────────────

	// ── Theme toggle ──────────────────────────────────────────────────────────
	"shell.systemTheme": "System theme",
	"shell.lightTheme": "Light theme",
	"shell.darkTheme": "Dark theme",
	"shell.text": "{name} (click to switch)",
	"shell.clickSwitchWithName": "{name} — click to switch",

	// ── Accent toggle ─────────────────────────────────────────────────────────
	"shell.brandGold": "Brand gold",
	"shell.monochrome": "Monochrome",
	"shell.oceanBlue": "Ocean blue",
	"shell.jadeGreen": "Jade green",
	"shell.clickForWithName": "Click for {name}",
	"shell.approvalNeeded": "Approval needed",
	"shell.approveTool": "Approve tool",
	"shell.denyTool": "Deny tool",
	"shell.waitingYourDecision": "Waiting for your decision",
} as const satisfies Record<ShellKey, string>;
