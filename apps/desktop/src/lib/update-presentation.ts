import type { TranslationKey } from "@musepi/client-core";
import type { UpdateRestartProgress } from "./electron";

/** One banner line for a downloaded update's idle handoff. */
export interface RestartHint {
	key: TranslationKey;
	params?: Record<string, string>;
}

/**
 * Pick the banner copy for a downloaded update: the main process ships stable
 * ids and counts, the renderer owns the wording. `count` is the number of
 * requests still running — what the user is actually waiting for — and never
 * the total session count.
 */
export function restartHint(restart: UpdateRestartProgress | undefined | null): RestartHint | null {
	if (!restart || restart.status === "idle") return null;
	if (restart.status === "installing") return { key: "update.installingUpdate" };
	const blockers = Array.isArray(restart.blockers) ? restart.blockers : [];
	if (restart.status === "blocked") {
		const reason = blockers[0];
		if (reason === "tasks-unavailable" || reason === "unknown") return { key: "update.restartBlockedUnavailable" };
		if (reason === "stop-failed" || reason === "handoff-failed") return { key: "update.restartBlockedFailed" };
		return { key: "update.restartBlockedBusy" };
	}
	if (blockers.includes("scheduled-reminders")) {
		return { key: "update.restartBlockedScheduled", params: { count: String(restart.scheduled ?? 0) } };
	}
	if (restart.inFlight > 0) {
		return { key: "update.restartWaitingWithCount", params: { count: String(restart.inFlight) } };
	}
	// Queued messages with no busy session still block the automatic path.
	if (blockers.includes("unknown")) return { key: "update.restartWaitingUnavailable" };
	if (blockers.includes("queued-messages")) return { key: "update.restartWaiting" };
	if (restart.auto) return { key: "update.restartImminent" };
	return null;
}
