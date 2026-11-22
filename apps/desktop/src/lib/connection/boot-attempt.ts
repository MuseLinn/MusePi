/**
 * One boot attempt, with the guarantee that every exit settles the outcome.
 *
 * The gate derives its surface from facts, so an attempt that fails to record
 * anything is indistinguishable from one the user cancelled — the shell then
 * shows the calm manager with a row reading 尚未尝试 after a launch that never
 * connected. Two ways that used to happen: a throw (an unparseable stored
 * endpoint, a failing probe) escaped past the settle call, and a body that
 * returned without settling looked identical to a success path that forgot.
 *
 * This wrapper owns both: a throw settles a failure, and returning without a
 * settlement is a failure too. The attempt itself never has to be correct about
 * the "nothing happened" case, because that case cannot leave this function.
 */

/** What one attempt settled on. */
export interface BootOutcome {
	/** True only when the client opened. */
	ok: boolean;
	/** The endpoint the settlement is about (the attempt's own, or the one that answered). */
	at: string;
	/** Human reason for a failure; null on success. */
	reason: string | null;
	/** True when the attempt threw rather than failing on its own terms. */
	threw: boolean;
}

/** Settle one attempt: `ok` plus the endpoint it applies to. */
export type BootSettle = (ok: boolean, at: string, reason?: string) => void;

/**
 * Run `attempt`, guaranteeing exactly one settlement.
 *
 * `fallback` supplies the endpoint and the user-facing reason used when the
 * attempt throws or returns without settling — a real sentence, never a raw
 * sentinel, because this string is what the row shows under 无法连接.
 */
export async function runBootAttempt(
	attempt: (settle: BootSettle) => Promise<void>,
	fallback: { at: string; reason: string },
): Promise<BootOutcome> {
	let outcome: BootOutcome | null = null;
	const settle: BootSettle = (ok, at, reason) => {
		// First settlement wins: a success followed by a late throw must not
		// turn a working connection into a failure.
		if (outcome) return;
		outcome = { ok, at, reason: ok ? null : (reason ?? fallback.reason), threw: false };
	};
	try {
		await attempt(settle);
	} catch (err) {
		// A success already settled is not undone by a late throw.
		if (outcome) return outcome;
		const message = err instanceof Error ? err.message.trim() : String(err).trim();
		outcome = { ok: false, at: fallback.at, reason: message || fallback.reason, threw: true };
	}
	// Returned without settling: the attempt never connected, so this is a
	// failure rather than "nothing happened".
	if (!outcome) return { ok: false, at: fallback.at, reason: fallback.reason, threw: false };
	return outcome;
}
