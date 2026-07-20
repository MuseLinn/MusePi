// ============================================================
// MusePi native goal integration (coding-agent, no extension host).
//
// The goal system runs as a first-class citizen of MusePi instead of
// an extension add-on: tools are registered natively into the session
// tool set, persistence goes through SessionManager.appendCustomEntry,
// turn recording subscribes to the session event stream, and the
// footer badge reuses the existing extension-status channel.
// ============================================================

import { goalManager, type PersistencePort, registerGoalTools, type SessionEntryLike } from "@musepi/core";
import type { AgentSession } from "../core/agent-session.ts";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { SessionManager } from "../core/session-manager.ts";

/** Collect the goal ToolDefinitions without a pi host. */
export function musepiGoalToolDefs(): ToolDefinition[] {
	const defs: ToolDefinition[] = [];
	registerGoalTools({ registerTool: (def: ToolDefinition) => defs.push(def) } as never, goalManager);
	return defs;
}

export interface MusepiGoalUi {
	setStatus(key: string, text: string | undefined): void;
	showError?(message: string): void;
	/** From settings: show the goal badge in the footer (default true). */
	badgeEnabled?: boolean;
}

/**
 * Bind goal persistence + turn recording + footer badge for one session.
 * Returns an unsubscribe function for rebinding/teardown.
 */
export function initMusepiGoal(session: AgentSession, sessionManager: SessionManager, ui: MusepiGoalUi): () => void {
	const port: PersistencePort = {
		append: (entryType, data) => {
			try {
				sessionManager.appendCustomEntry(entryType, data);
			} catch {
				/* session replaced mid-flight — fail safe */
			}
		},
		entries: () => {
			try {
				return sessionManager.getEntries() as SessionEntryLike[];
			} catch {
				return [];
			}
		},
	};
	goalManager.bindPersistence(port);
	goalManager.tryRestoreFromEntries(Array.from(port.entries()));

	const updateBadge = () => {
		if (ui.badgeEnabled === false) {
			ui.setStatus("goal", undefined);
			return;
		}
		const badge = goalManager.buildFooterBadge();
		ui.setStatus("goal", badge || undefined);
	};
	updateBadge();

	const unsubscribe = session.subscribe((event: unknown) => {
		const e = event as {
			type?: string;
			message?: { role?: string; usage?: { input?: number; output?: number } };
		};
		if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) {
			const tokens = (e.message.usage.input || 0) + (e.message.usage.output || 0);
			if (tokens > 0) {
				const { crossedBudget } = goalManager.recordTurn(tokens);
				if (crossedBudget) ui.showError?.("Goal budget exceeded — goal blocked.");
				updateBadge();
			}
		}
	});
	return unsubscribe;
}
