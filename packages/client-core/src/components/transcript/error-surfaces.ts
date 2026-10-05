import type { SessionEntry } from "@musepi/pi-wire";

/**
 * Decides which surface shows a failed turn.
 *
 * A terminal retry failure writes the same failure twice: into the assistant
 * message's errorMessage, and into a durable `retry_failure` custom message so
 * the reason survives a reload. Both are needed — the assistant message is what a
 * consumer reads, the custom message is what re-explains the stopped round after
 * the empty turn is dropped. But rendering both means one failure appears in two
 * guises, which is what the transcript used to do.
 *
 * So the surfaces are ranked and only the top one renders the reason. This is the
 * same shape as the reference implementations: one failure fact, one owning
 * surface, the other either silent or reduced to what it alone knows.
 *
 * Ranking, highest first:
 *
 *  1. The assistant message that carries `stopReason: "error"` — it is the
 *     canonical record, it sits in the flow where the reply would have been, and
 *     it survives reload on its own.
 *  2. The `retry_failure` row — kept because it also knows the attempt count and
 *     whether the provider returned empty output, which the assistant message
 *     does not. When the assistant row is present this row drops the reason and
 *     keeps only that extra fact.
 *
 * The comparison is on the error text, not on entry position: two surfaces are
 * reporting one fact exactly when they report the same text. Ordering alone
 * cannot decide it, because the two writers are not guaranteed to interleave in
 * a fixed sequence.
 */
export interface ErrorSurfacePlan {
	/** Entry ids whose assistant message carries the reason. */
	ownedByAssistant: ReadonlySet<string>;
	/** Entry ids of `retry_failure` rows that must not repeat the reason. */
	suppressedReason: ReadonlySet<string>;
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

function retryReasonOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom_message" || entry.customType !== RETRY_FAILURE) return undefined;
	// A custom message's content is a string or a content-part array; the retry
	// path always writes a string, and anything else is not a reason to suppress.
	if (typeof entry.content !== "string") return undefined;
	const text = entry.content.trim();
	return text.length > 0 ? text : undefined;
}

/**
 * Rank the error surfaces in `entries`.
 *
 * Only consecutive windows matter: a retry_failure row states the reason for the
 * round that just failed, so it is matched against error assistant messages that
 * sit within `WINDOW` entries before it. Scanning the whole transcript instead
 * would let a failure from an hour ago suppress today's card, which is wrong —
 * those really are two separate failures that both happened.
 */
const WINDOW = 6;

export function planErrorSurfaces(entries: readonly SessionEntry[]): ErrorSurfacePlan {
	const ownedByAssistant = new Set<string>();
	const suppressedReason = new Set<string>();

	for (const [index, entry] of entries.entries()) {
		const id = entry.id;
		if (!id) continue;

		const reason = retryReasonOf(entry);
		if (reason !== undefined) {
			// Look back for an assistant row in this round already carrying the same
			// text. When one is there, this row keeps its attempt counter but yields
			// the reason.
			const start = Math.max(0, index - WINDOW);
			for (let back = index - 1; back >= start; back--) {
				const earlier = entries[back];
				if (!earlier?.id) continue;
				if (errorTextOf(earlier) === reason) {
					ownedByAssistant.add(earlier.id);
					suppressedReason.add(id);
					break;
				}
			}
			continue;
		}

		if (errorTextOf(entry) !== undefined) ownedByAssistant.add(id);
	}

	return { ownedByAssistant, suppressedReason };
}
