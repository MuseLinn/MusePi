import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core/src/i18n";
import { dismissActionToast, getToasts } from "@musepi/client-core/src/lib/action-toast";
import { sessionNoticeForEvent } from "../src/lib/session-notice";

afterEach(() => {
	for (const toast of getToasts()) dismissActionToast(toast.id);
});

describe("sessionNoticeForEvent", () => {
	it("maps a daemon notice and keeps its source as the dedupe key", () => {
		expect(
			sessionNoticeForEvent({ type: "notice", level: "warning", message: "daemon says", source: "update" }),
		).toEqual({
			toast: { kind: "warning", message: "daemon says", dedupeKey: "session:notice:update" },
		});
	});

	it("defaults a source-less notice to the daemon source", () => {
		expect(sessionNoticeForEvent({ type: "notice", level: "info", message: "x" })).toEqual({
			toast: { kind: "info", message: "x", dedupeKey: "session:notice:daemon" },
		});
	});

	it("reports a retry attempt as an info toast", () => {
		expect(
			sessionNoticeForEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "429" }),
		).toEqual({
			toast: {
				kind: "info",
				message: t("sessions.retryWithAttemptWithMaxWithReason", { attempt: "2", max: "3", reason: "429" }),
				dedupeKey: "session:retry",
			},
		});
	});

	it("clears the retry toast when the retry succeeds", () => {
		expect(sessionNoticeForEvent({ type: "auto_retry_end", success: true })).toEqual({ dismiss: "session:retry" });
	});

	it("turns a failed retry into a persistent error", () => {
		expect(sessionNoticeForEvent({ type: "auto_retry_end", success: false, finalError: "boom" })).toEqual({
			toast: { kind: "error", message: "boom", dedupeKey: "session:retry" },
		});
	});

	it("reports compaction start, skip, abort, failure, and success", () => {
		expect(sessionNoticeForEvent({ type: "auto_compaction_start", reason: "threshold" })).toEqual({
			toast: {
				kind: "info",
				message: t("sessions.compactingContextWithReason", { reason: "threshold" }),
				dedupeKey: "session:compaction",
			},
		});
		expect(sessionNoticeForEvent({ type: "auto_compaction_end", aborted: false, skipped: true })).toEqual({
			dismiss: "session:compaction",
		});
		expect(sessionNoticeForEvent({ type: "auto_compaction_end", aborted: true })).toEqual({
			toast: { kind: "info", message: t("sessions.compactionAborted"), dedupeKey: "session:compaction" },
		});
		expect(sessionNoticeForEvent({ type: "auto_compaction_end", aborted: false, errorMessage: "nope" })).toEqual({
			toast: {
				kind: "error",
				message: t("sessions.compactionFailedWithReason", { reason: "nope" }),
				dedupeKey: "session:compaction",
			},
		});
		expect(sessionNoticeForEvent({ type: "auto_compaction_end", aborted: false })).toEqual({
			toast: { kind: "info", message: t("sessions.contextCompacted"), dedupeKey: "session:compaction" },
		});
	});
});
