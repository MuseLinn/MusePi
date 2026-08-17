import type { ShellKey } from "../zh-CN/shell.js";

export const shell = {
	// ── Connect screen ────────────────────────────────────────────────────────
	"musepi collab": "MusePi Collab",
	"live agent session, in your browser": "Live agent session, in your browser",
	"join link": "Join link",
	"display name": "Display name",
	"paste a join link first": "Paste a join link first",
	"paste a /collab link from any musepi session": "Paste a /collab link from any musepi session",
	"ws://host:port/r/room.key": "ws://host:port/r/room.key",

	// ── Header bar ────────────────────────────────────────────────────────────
	"read-only": "Read-only",
	"read-only link — watching only": "Read-only link — watching only",
	"context · {pct}": "Context · {pct}",
	"hide agents": "Hide agents",
	"show agents": "Show agents",
	"leave session": "Leave session",
	"connecting to relay…": "Connecting to relay…",
	"joining session…": "Joining session…",
	"reconnecting…": "Reconnecting…",
	"session ended": "Session ended",
	"show main window": "Show main window",
	quit: "Quit",
	"New link": "New link",

	// ── Banners ───────────────────────────────────────────────────────────────

	// ── Theme toggle ──────────────────────────────────────────────────────────
	"System theme": "System theme",
	"Light theme": "Light theme",
	"Dark theme": "Dark theme",
	"{name} (click to switch)": "{name} (click to switch)",
	"{name} — click to switch": "{name} — click to switch",

	// ── Accent toggle ─────────────────────────────────────────────────────────
	"Brand pink": "Brand pink",
	Monochrome: "Monochrome",
	"Ocean blue": "Ocean blue",
	"Jade green": "Jade green",
	"click for {name}": "Click for {name}",
} as const satisfies Record<ShellKey, string>;
