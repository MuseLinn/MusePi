/**
 * Reconnect restore of the session that was on screen when the daemon dropped.
 *
 * The shell re-opens that session when the socket comes back. A daemon that was
 * rebuilt faster than the shell noticed the drop accepts the socket before it
 * accepts requests, so the first open comes back "not connected". One refusal
 * is not a verdict on the session: a bounded retry covers that gap, and
 * `stillWanted` ends it the moment the user takes over (the welcome page or
 * another session), so a deliberate leave is never undone by the restore.
 */

/** What one open attempt settled to. `transient` is the only retryable one. */
export type SessionOpenOutcome =
	| { status: "opened" }
	/** The socket refused the request (not accepting yet / closed again). */
	| { status: "transient"; error: unknown }
	/** A newer user action owns the screen; this attempt has no say. */
	| { status: "superseded" }
	/** A verdict on the session itself (gone, unreadable): retrying repeats it. */
	| { status: "failed"; error: unknown };

export type SessionReopenStatus = "opened" | "cancelled" | "superseded" | "failed" | "exhausted";

export interface SessionReopenResult {
	status: SessionReopenStatus;
	/** Open attempts actually issued (0 when the user had already left). */
	attempts: number;
	/** Last transient error when the retries ran out. */
	error: unknown;
}

export interface SessionReopenOptions {
	sessionId: string;
	open: (sessionId: string) => Promise<SessionOpenOutcome>;
	/** False once the user left this session or a newer restore took over. */
	stillWanted: () => boolean;
	/** Injectable for tests; a real timer by default. */
	wait?: (ms: number) => Promise<void>;
	maxAttempts?: number;
}

/** Bounded so a daemon that never comes back cannot keep the shell retrying. */
export const SESSION_REOPEN_MAX_ATTEMPTS = 6;

/** Backoff for attempts 1..5: ~7s total, enough to cover a daemon rebuild that
 *  finishes after the socket does. Longer rebuilds arrive as a new `open`. */
export const SESSION_REOPEN_RETRY_DELAYS_MS: readonly number[] = [250, 600, 1_200, 2_000, 3_000];

/** Delay before the next attempt, after `attemptsMade` settle with a refusal.
 *  The last delay repeats, so a custom attempt cap stays bounded. */
export function reopenRetryDelay(attemptsMade: number): number {
	const delays = SESSION_REOPEN_RETRY_DELAYS_MS;
	const index = Math.min(Math.max(attemptsMade - 1, 0), delays.length - 1);
	return delays[index] ?? 0;
}

/**
 * Whether an open error means "the connection is not ready", not "this session
 * is broken". The transport rejects a request on a socket that is closed or
 * still opening; a request timeout is deliberately excluded — a slow daemon
 * may already be serving the session.
 */
export function isConnectionNotReadyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /not connected|connection closed|cannot connect/i.test(message);
}

const defaultWait = (ms: number): Promise<void> =>
	new Promise(resolve => {
		setTimeout(resolve, ms);
	});

/** Re-open one session with bounded backoff; resolves once it is open, the
 *  user left, another open took over, or a non-transient failure settled it. */
export async function runSessionReopen(options: SessionReopenOptions): Promise<SessionReopenResult> {
	const maxAttempts = options.maxAttempts ?? SESSION_REOPEN_MAX_ATTEMPTS;
	const wait = options.wait ?? defaultWait;
	let attempts = 0;
	let error: unknown = null;
	while (attempts < maxAttempts) {
		if (!options.stillWanted()) return { status: "cancelled", attempts, error };
		attempts++;
		const outcome = await options.open(options.sessionId);
		if (outcome.status === "opened") return { status: "opened", attempts, error: null };
		if (outcome.status === "superseded") return { status: "superseded", attempts, error: null };
		if (outcome.status === "failed") return { status: "failed", attempts, error: outcome.error };
		error = outcome.error;
		if (attempts >= maxAttempts) break;
		await wait(reopenRetryDelay(attempts));
	}
	return { status: "exhausted", attempts, error };
}
