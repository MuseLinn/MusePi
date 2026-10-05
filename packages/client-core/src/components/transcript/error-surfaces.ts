import type { SessionEntry } from "@musepi/pi-wire";

/**
 * Decides which surface shows a failed round.
 *
 * A terminal retry failure writes one fact twice: into the assistant message's
 * `errorMessage`, and into a durable `retry_failure` custom message so the reason
 * survives a reload. Both writes are needed — the assistant message is what a
 * consumer reads, the custom message is what re-explains the stopped round after
 * the empty turn is dropped — but rendering both means one failure appears twice,
 * which is what the transcript used to do.
 *
 * So the surfaces are ranked and only the top one renders, with the losing
 * surface's unique facts merged onto the winner:
 *
 *  1. The assistant message carrying `stopReason: "error"`. Its reason stands in
 *     for the reply, so it owns the round. When a `retry_failure` row in the same
 *     round reported the same text, that row's attempt count moves here and the
 *     row itself renders nothing.
 *  2. The `retry_failure` row, when no assistant message in the round took the
 *     reason. This is the runtime-level failure the reference implementations
 *     dock above the composer: it is not a message, so it does not join the flow.
 *
 * The comparison is on the error text, not on entry position: two surfaces are
 * reporting one fact exactly when they report the same text. Ordering alone
 * cannot decide it, because the two writers are not guaranteed to interleave in a
 * fixed sequence.
 */

/** Extra facts a `retry_failure` row knows that the assistant message does not. */
export interface RetryFailureFacts {
	/** How many attempts the retry loop spent before giving up. */
	attempt?: number;
}

export interface ErrorSurfacePlan {
	/**
	 * Assistant error rows that own their round, keyed by entry id, carrying any
	 * facts merged in from the `retry_failure` row they absorbed.
	 */
	ownedByAssistant: ReadonlyMap<string, RetryFailureFacts>;
	/**
	 * The `retry_failure` row to dock above the composer, or null when none
	 * qualifies — either there is no unabsorbed failure, or the user has since
	 * sent another prompt, which supersedes it.
	 */
	banner: { reason: string; attempt?: number } | null;
}

/** The custom-message type the terminal retry path writes. */
const RETRY_FAILURE = "retry_failure";

function errorTextOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const msg = entry.message;
	if (msg.role !== "assistant" || msg.stopReason !== "error") return undefined;
	const text = msg.errorMessage?.trim();
	return text && text.length > 0 ? text : undefined;
}

interface RetryFailureRow {
	reason: string;
	attempt?: number;
}

function retryFailureOf(entry: SessionEntry): RetryFailureRow | undefined {
	if (entry.type !== "custom_message" || entry.customType !== RETRY_FAILURE) return undefined;
	// A custom message's content is a string or a content-part array; the retry
	// path always writes a string, and anything else is not a reason to report.
	if (typeof entry.content !== "string") return undefined;
	const reason = entry.content.trim();
	if (reason.length === 0) return undefined;
	const attempt =
		entry.details !== null &&
		typeof entry.details === "object" &&
		"attempt" in entry.details &&
		typeof entry.details.attempt === "number"
			? entry.details.attempt
			: undefined;
	return { reason, attempt };
}

function isUserPrompt(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/**
 * Rank the error surfaces in `entries`.
 *
 * Only consecutive windows matter: a retry_failure row states the reason for the
 * round that just failed, so it is matched against error assistant messages that
 * sit within `WINDOW` entries before it. Scanning the whole transcript instead
 * would let a failure from an hour ago absorb today's card, which is wrong —
 * those really are two separate failures that both happened.
 */
const WINDOW = 6;

export function planErrorSurfaces(entries: readonly SessionEntry[]): ErrorSurfacePlan {
	/** Error assistant row ids, in transcript order. */
	const assistantErrorIds: string[] = [];
	/** Attempt counts merged onto an owning assistant row, first claim winning. */
	const attemptsByOwner = new Map<string, number>();
	/** Unabsorbed failures, in transcript order; the last one is the current round's. */
	const bannerCandidates: { index: number; row: RetryFailureRow }[] = [];

	for (const [index, entry] of entries.entries()) {
		const row = retryFailureOf(entry);
		if (row !== undefined) {
			// Look back for an assistant row in this round already carrying the same
			// text. When one is there, it keeps the reason and absorbs the attempt
			// count; this row becomes a banner candidate's absence rather than a row.
			const start = Math.max(0, index - WINDOW);
			let owner: string | undefined;
			for (let back = index - 1; back >= start; back--) {
				const earlier = entries[back];
				if (!earlier?.id) continue;
				if (errorTextOf(earlier) === row.reason) {
					owner = earlier.id;
					break;
				}
			}
			if (owner !== undefined) {
				// The first row to claim a round sets its attempt count; a second one
				// is a separate round reporting the same text, so it must not
				// overwrite the count the reader already saw.
				if (row.attempt !== undefined && !attemptsByOwner.has(owner)) {
					attemptsByOwner.set(owner, row.attempt);
				}
			} else {
				bannerCandidates.push({ index, row });
			}
			continue;
		}

		const text = errorTextOf(entry);
		if (text !== undefined && entry.id && !assistantErrorIds.includes(entry.id)) {
			assistantErrorIds.push(entry.id);
		}
	}

	// Assembled after the scan rather than during it: an assistant row is always a
	// candidate owner from the moment it is seen, so registering it mid-loop would
	// make the first-claim-wins guard reject the very attempt count that row is
	// supposed to inherit.
	const ownedByAssistant = new Map<string, RetryFailureFacts>();
	for (const id of assistantErrorIds) {
		const attempt = attemptsByOwner.get(id);
		ownedByAssistant.set(id, attempt === undefined ? {} : { attempt });
	}

	// The banner states the current round's failure, so a prompt sent after it
	// retires it. This is what makes the next send the dismissal: there is no close
	// button, because a fresh prompt is the honest way to say "that is settled".
	const banner = pickCurrentBanner(entries, bannerCandidates);
	return { ownedByAssistant, banner };
}

/**
 * The last unabsorbed failure, provided no user prompt follows it.
 *
 * The candidate's own index is used rather than "the failure is the final entry":
 * a later retry_failure row may have been absorbed by an assistant message, in
 * which case it is not a candidate and must not stand in for one.
 *
 * The scan looks for a prompt rather than for end-of-transcript, because tool
 * results and bookkeeping entries can land after the failure without the user
 * having moved on, and those must not retire it.
 */
function pickCurrentBanner(
	entries: readonly SessionEntry[],
	candidates: readonly { index: number; row: RetryFailureRow }[],
): ErrorSurfacePlan["banner"] {
	const last = candidates[candidates.length - 1];
	if (!last) return null;
	for (let forward = last.index + 1; forward < entries.length; forward++) {
		const entry = entries[forward];
		if (entry && isUserPrompt(entry)) return null;
	}
	return last.row;
}
