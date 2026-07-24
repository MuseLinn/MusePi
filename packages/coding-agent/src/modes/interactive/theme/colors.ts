// ============================================================
// Semantic token mappings: application states → ThemeColor tokens
//
// Pure module — no pi / pi-tui imports, safe for @musepi/core.
// ThemeColor is the union type from theme.ts (46 foreground tokens).
// ============================================================

import type { ThemeColor } from "./theme.ts";

// ── Mode / State types ───────────────────────────────────────

export type PermissionMode = "auto" | "yolo" | "manual";
export type AgentLifecycleState = "active" | "idle" | "stopped";
export type GoalIndicator = "active" | "paused" | "blocked" | "complete";

// ── Semantic color lookups ───────────────────────────────────

/** Permission mode → color token (mirrors OMP's /permission routing). */
export const PERMISSION_MODE_COLORS: Record<PermissionMode, ThemeColor> = {
	auto: "success",
	yolo: "warning",
	manual: "accent",
};

/** Sub-agent task status → color token. */
export const AGENT_STATUS_COLORS: Record<"pending" | "running" | "done" | "failed" | "aborted", ThemeColor> = {
	pending: "muted",
	running: "warning",
	done: "success",
	failed: "error",
	aborted: "warning",
};

/** Goal lifecycle status → color token. */
export const GOAL_STATUS_COLORS: Record<GoalIndicator, ThemeColor> = {
	active: "success",
	paused: "warning",
	blocked: "warning",
	complete: "info",
};

/** Lifecycle agent state → color token. */
export const LIFECYCLE_STATE_COLORS: Record<AgentLifecycleState, ThemeColor> = {
	active: "success",
	idle: "muted",
	stopped: "error",
};

/** Swarm summary: counts of agents in each state → an overall color. */
export function swarmSummaryColor(done: number, running: number, failed: number, total: number): ThemeColor {
	if (failed > 0) return "error";
	if (running > 0) return "warning";
	if (done === total) return "success";
	return "muted";
}

/**
 * Minimal theme interface for semantic rendering.
 * Mirrors OMP's TodoTheme pattern — nullable, graceful plain-text fallback.
 */
export type SemTheme = {
	fg: (color: ThemeColor | string, text: string) => string;
	bold?: (text: string) => string;
	italic?: (text: string) => string;
	strikethrough?: (text: string) => string;
} | null;

/** Resolve a SemTheme to always-callable functions (plain-text fallback). */
export function resolveSemTheme(th: SemTheme): {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
} {
	if (!th) {
		return {
			fg: (_, t) => t,
			bold: (t) => t,
			italic: (t) => t,
			strikethrough: (t) => t,
		};
	}
	return {
		fg: (c, t) => th.fg(c as ThemeColor, t),
		bold: (t) => th.bold?.(t) ?? t,
		italic: (t) => th.italic?.(t) ?? t,
		strikethrough: (t) => th.strikethrough?.(t) ?? t,
	};
}
