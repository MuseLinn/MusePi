/**
 * Journals off-transcript model calls (compaction summaries, handoffs, recaps)
 * as `model_usage` entries, so their spend counts in session totals and what
 * they were billed for survives a restart.
 *
 * The entry never enters the model context and is never rendered in the
 * transcript: its only consumers are the usage totals and per-purpose
 * reporting. A write failure is logged and dropped — accounting must never
 * fail the call it accounts for.
 */
import type { AssistantMessage } from "@musepi/pi-ai";
import { logger } from "@musepi/pi-utils";
import type { CompactionMethod } from "./compaction-methods";
import type { ModelUsageRecord } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** The session surface a journal needs; journal-only managers omit it. */
export type ModelUsageLedger = Pick<SessionManager, "appendModelUsage">;

/** Whether `manager` can journal model usage. */
export function isModelUsageLedger(manager: Partial<ModelUsageLedger> | undefined): manager is ModelUsageLedger {
	return manager?.appendModelUsage !== undefined;
}

/** Receives each settled attempt of a side-channel completion. */
export type CompletionJournal = (message: AssistantMessage, role?: string) => void;

/**
 * Build a reporter that journals every billed attempt of one side-channel
 * request. Call it once per request, right before sending, and hand it each
 * attempt, failed ones included.
 */
export function journalCompletion(
	manager: Partial<ModelUsageLedger> | undefined,
	options: { purpose: string; role?: string },
): CompletionJournal | undefined {
	if (!isModelUsageLedger(manager)) return undefined;
	return (message, role) => {
		try {
			const resolvedRole = options.role ?? role;
			const record: ModelUsageRecord = {
				purpose: options.purpose,
				...(resolvedRole ? { role: resolvedRole } : {}),
				api: message.api,
				provider: message.provider,
				model: message.model,
				usage: message.usage,
				stopReason: message.stopReason,
				...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
				...(message.duration !== undefined ? { duration: message.duration } : {}),
			};
			manager.appendModelUsage(record);
		} catch (error) {
			logger.debug("model usage journal failed", { purpose: options.purpose, error: String(error) });
		}
	};
}

/**
 * Journal for one compaction attempt. The method names the purpose so remote,
 * handoff, snapcompact and summary spend stay apart in reporting, while every
 * purpose still groups under its `compaction:` base.
 */
export function journalCompaction(
	manager: Partial<ModelUsageLedger> | undefined,
	method: CompactionMethod | undefined,
): CompletionJournal | undefined {
	return journalCompletion(manager, { purpose: `compaction:${method ?? "unknown"}` });
}
