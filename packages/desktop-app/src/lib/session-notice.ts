import { t } from "@musepi/client-core/src/i18n";
import type { ActionToastInput } from "./action-toast";

/** The agent events that should surface as in-app notices. */
export type SessionNoticeEvent =
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; finalError?: string }
	| { type: "auto_compaction_start"; reason: string }
	| { type: "auto_compaction_end"; aborted: boolean; errorMessage?: string; skipped?: boolean };

/** One toast to show, or a source key whose toast has recovered. */
export type SessionNoticeAction = { toast: ActionToastInput } | { dismiss: string };

const RETRY_KEY = "session:retry";
const COMPACTION_KEY = "session:compaction";

/**
 * Map one agent event onto the shared toast stack.
 *
 * Retry and compaction are long-lived states, not one-shot messages: every
 * update reuses its source key so the stack shows the latest step instead of
 * piling up "retrying…" rows.
 */
export function sessionNoticeForEvent(event: SessionNoticeEvent): SessionNoticeAction | null {
	switch (event.type) {
		case "notice":
			return {
				toast: {
					kind: event.level,
					message: event.message,
					dedupeKey: `session:notice:${event.source ?? "daemon"}`,
				},
			};
		case "auto_retry_start":
			return {
				toast: {
					kind: "info",
					message: t("sessions.retryWithAttemptWithMaxWithReason", {
						attempt: String(event.attempt),
						max: String(event.maxAttempts),
						reason: event.errorMessage,
					}),
					dedupeKey: RETRY_KEY,
				},
			};
		case "auto_retry_end":
			if (event.success) return { dismiss: RETRY_KEY };
			return {
				toast: {
					kind: "error",
					message: event.finalError ?? t("sessions.retryFailed"),
					dedupeKey: RETRY_KEY,
				},
			};
		case "auto_compaction_start":
			return {
				toast: {
					kind: "info",
					message: t("sessions.compactingContextWithReason", { reason: event.reason }),
					dedupeKey: COMPACTION_KEY,
				},
			};
		case "auto_compaction_end":
			if (event.skipped) return { dismiss: COMPACTION_KEY };
			if (event.aborted) {
				return {
					toast: { kind: "info", message: t("sessions.compactionAborted"), dedupeKey: COMPACTION_KEY },
				};
			}
			if (event.errorMessage) {
				return {
					toast: {
						kind: "error",
						message: t("sessions.compactionFailedWithReason", { reason: event.errorMessage }),
						dedupeKey: COMPACTION_KEY,
					},
				};
			}
			return {
				toast: { kind: "info", message: t("sessions.contextCompacted"), dedupeKey: COMPACTION_KEY },
			};
		default:
			return null;
	}
}
