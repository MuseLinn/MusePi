// ============================================================
// MusePi native background-task + cron integration (no extension host).
//
// The background task manager (run_background / task_list / task_output
// / task_stop) and the cron scheduler become built-ins: tool defs are
// collected from the core registration functions through a fake-pi
// shim (same pattern as goal), persistence flows through
// SessionManager.appendCustomEntry, and cron fires prompts via
// AgentSession.prompt().
// ============================================================

import { cronManager, registerCronTools } from "@musepi/core/task/cron.js";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { backgroundManager, registerBackgroundTools } from "./manager.ts";

/** Collect run_background / task_list / task_output / task_stop defs. */
export function musepiBackgroundToolDefs(): ToolDefinition[] {
	const defs: ToolDefinition[] = [];
	registerBackgroundTools({ registerTool: (def: ToolDefinition) => defs.push(def) } as never);
	return defs;
}

/** Collect cron_create / cron_list / cron_delete defs. */
export function musepiCronToolDefs(): ToolDefinition[] {
	const defs: ToolDefinition[] = [];
	registerCronTools({ registerTool: (def: ToolDefinition) => defs.push(def) } as never);
	return defs;
}

/**
 * Bind the background manager + cron to a session. Idempotent per
 * session bind (restore resets from persisted entries each time).
 */
export function initMusepiTask(session: AgentSession, sessionManager: SessionManager): void {
	backgroundManager.bind(
		(type, data) => {
			try {
				sessionManager.appendCustomEntry(type, data);
			} catch {
				/* stale session — fail safe */
			}
		},
		() => {
			/* notifications surface through task entries already */
		},
	);
	try {
		backgroundManager.restore(sessionManager.getEntries());
	} catch {
		/* not critical */
	}

	cronManager.bindPromptSender(
		async (prompt) => {
			try {
				await session.prompt(prompt);
			} catch (e: any) {
				console.error(`[cron] prompt failed: ${e?.message || String(e)}`);
			}
		},
		(type, data) => {
			try {
				sessionManager.appendCustomEntry(type, data);
			} catch {
				/* stale session — fail safe */
			}
		},
	);
	try {
		cronManager.restore(sessionManager.getEntries());
	} catch {
		/* not critical */
	}
}
