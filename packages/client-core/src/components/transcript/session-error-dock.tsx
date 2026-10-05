/**
 * The session-level error surface: a dock above the composer, outside the
 * transcript flow.
 *
 * It reports two things the transcript cannot, both about the *current* round
 * rather than about any message:
 *
 *  - The runtime gave up without reporting into any message (a terminal retry
 *    failure). This branch disappears on its own: the next prompt supersedes it,
 *    so there is no close button to add.
 *  - Nothing came back at all. A prompt the session is idle on, with no reply and
 *    no error, is a turn that never began — the send was accepted and the model
 *    was never asked. This is the branch that is easy to miss, because the
 *    transcript simply stops.
 *
 * The no-reply branch guesses, and a guess that can be checked should be. The
 * store may simply have missed the reply — a stream that drops the turn's events
 * leaves the prompt as the last entry even though the daemon answered it, and
 * nothing else re-reads the session. So the tail is re-read from the daemon at
 * scheduled offsets and the notice waits for the first read to settle: a reply it
 * finds replaces the prompt and the notice never appears, while a read that fails
 * shows it, because a failed check must not hide a genuine silence.
 *
 * The two verdicts are pure functions so they can be decided without a DOM; only
 * the timers live in the component.
 */
import type { SessionEntry } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import { SessionErrorBanner } from "./error-notice.js";
import { planErrorSurfaces } from "./error-surfaces.js";

/**
 * How long a prompt may sit unanswered on an idle session before this dock calls
 * it a reply that never began. Long enough that a slow first token does not trip
 * it, short enough that a silent stall is reported while the user is still there.
 */
export const UNANSWERED_AFTER_MS = 5_000;

/**
 * Offsets (ms after the prompt starts to look unanswered) at which the transcript
 * is re-read from the daemon. The later reads keep running under a visible
 * notice, so a late reply still replaces it; a genuine silence stops costing
 * requests after the last offset.
 */
export const UNANSWERED_RECHECK_DELAYS_MS: readonly number[] = [0, 10_000, 30_000];

type RecheckScheduler = {
	setTimeout(callback: () => void, ms: number): number;
	clearTimeout(handle: number): void;
};

/**
 * Runs `refetch` once per offset in `delays` until cancelled, calling `onSettled`
 * after each read finishes whether it succeeded or failed. A read that settles
 * after cancellation reports nothing, so a read started for a superseded prompt
 * cannot decide the verdict for the current one.
 */
export function scheduleUnansweredRechecks(
	refetch: () => Promise<void> | void,
	scheduler: RecheckScheduler,
	onSettled: () => void = () => undefined,
	delays: readonly number[] = UNANSWERED_RECHECK_DELAYS_MS,
): () => void {
	let cancelled = false;
	const settle = () => {
		if (!cancelled) onSettled();
	};
	const handles = delays.map(delay =>
		scheduler.setTimeout(() => {
			if (cancelled) return;
			void Promise.resolve(refetch()).then(settle, settle);
		}, delay),
	);
	return () => {
		cancelled = true;
		for (const handle of handles) scheduler.clearTimeout(handle);
	};
}

/** A prompt that currently looks like a reply that never began. */
export interface UnansweredCandidate {
	/** Ties a verification result to this prompt rather than to a moment. */
	key: string;
	/** When the prompt was written, ms epoch. */
	sentAt: number;
}

/**
 * The last message entry, as far as "did a reply follow?" is concerned.
 *
 * Only an assistant message ends a turn. Every other role — a prompt, a plumbing
 * record — is timed by when it was written, so the timestamp here is when the
 * prompt was sent rather than a completion time. Reading a prompt's creation time
 * as a completion would make every fresh send look unanswered since the epoch.
 */
function readLastMessageEntry(entries: readonly SessionEntry[]): Extract<SessionEntry, { type: "message" }> | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message") return entry;
	}
	return null;
}

/**
 * The retry failure to report, or null when none applies.
 *
 * Re-read on every call rather than cached: it is a scan over the tail, and the
 * answer changes as entries land.
 */
export function readRetryBanner(entries: readonly SessionEntry[]): { reason: string; attempt?: number } | null {
	return planErrorSurfaces(entries).banner;
}

/**
 * The prompt that looks unanswered, or null when the round is not stalled.
 *
 * A round whose reason the transcript already shows is not unanswered from the
 * dock's point of view — the user has been told why — so an owned assistant row
 * also silences this branch.
 */
export function readUnansweredCandidate(
	entries: readonly SessionEntry[],
	working: boolean,
): UnansweredCandidate | null {
	if (working) return null;
	const plan = planErrorSurfaces(entries);
	if (plan.banner !== null || plan.ownedByAssistant.size > 0) return null;

	const last = readLastMessageEntry(entries);
	if (last?.message.role !== "user") return null;
	const sentAt = Date.parse(last.timestamp);
	if (Number.isNaN(sentAt) || sentAt <= 0) return null;
	return { key: last.id ?? `ts:${sentAt}`, sentAt };
}

export interface SessionErrorDockProps {
	entries: readonly SessionEntry[];
	/** The session is mid-turn; a slow round is still working, not unanswered. */
	working: boolean;
	/**
	 * Re-reads the transcript from the daemon. Required for the no-reply branch:
	 * without it there is no way to tell a missed stream from a real silence, and
	 * guessing would put a notice in front of turns that were answered.
	 */
	verifyTranscript?: () => Promise<void> | void;
}

export function SessionErrorDock({ entries, working, verifyTranscript }: SessionErrorDockProps): ReactNode {
	const banner = useMemo(() => readRetryBanner(entries), [entries]);
	const candidate = useMemo(() => readUnansweredCandidate(entries, working), [entries, working]);
	const candidateKey = candidate?.key ?? null;

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (candidate === null) return undefined;
		const remaining = UNANSWERED_AFTER_MS - (Date.now() - candidate.sentAt);
		if (remaining <= 0) return undefined;
		const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
		return () => window.clearTimeout(timer);
	}, [candidateKey, candidate]);

	const due = candidate !== null && Math.max(now, Date.now()) - candidate.sentAt >= UNANSWERED_AFTER_MS;

	// The verdict is tied to the prompt, so a send that supersedes it clears the
	// notice by changing the key rather than by needing an explicit reset.
	const [verifiedKey, setVerifiedKey] = useState<string | null>(null);
	const verifyKey = due && candidateKey !== null && verifyTranscript !== undefined ? candidateKey : null;
	useEffect(() => {
		if (verifyKey === null || verifyTranscript === undefined) return undefined;
		return scheduleUnansweredRechecks(verifyTranscript, window, () => setVerifiedKey(verifyKey));
	}, [verifyKey, verifyTranscript]);

	// The retry branch wins when both apply: it names a reason, so a silence notice
	// on top of it would restate a stall the user has already been told about.
	if (banner !== null) {
		return (
			<SessionErrorBanner
				title={t("model error")}
				raw={banner.reason}
				meta={
					banner.attempt === undefined ? undefined : t("retry attempt {count}", { count: String(banner.attempt) })
				}
			/>
		);
	}

	const unanswered = due && candidateKey !== null && verifiedKey === candidateKey;
	if (!unanswered) return null;

	return (
		<SessionErrorBanner
			title={t("no reply")}
			raw={t("no reply detail")}
			action={
				<button
					type="button"
					className="tr-error-fold-toggle"
					onClick={() => {
						if (verifyTranscript === undefined) return;
						void Promise.resolve(verifyTranscript()).then(() => setVerifiedKey(candidateKey));
					}}
				>
					{t("check again")}
				</button>
			}
		/>
	);
}
