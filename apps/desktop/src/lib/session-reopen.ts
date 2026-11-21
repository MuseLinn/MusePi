/**
 * Bounded retries for opening a session.
 *
 * A daemon rebuilt faster than the shell noticed the drop accepts the socket
 * before it accepts requests, so an open can come back "not connected" while
 * the daemon is still starting. One refusal is not a verdict on the session:
 * `runSessionReopen` retries on a bounded backoff, and `stillWanted` ends the
 * retries the moment the user takes over (the welcome page or another
 * session), so a deliberate leave is never undone. `SessionOpenScheduler`
 * gives every open intent — the reconnect restore and a user pick during it —
 * the same chain, with only the newest intent surviving.
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

/** One attempt, with a thrown request folded into the same outcome the caller
 *  would have returned — an exception must not escape the retry chain and turn
 *  a refused open into a silent one. */
async function settleOpen(open: SessionReopenOptions["open"], sessionId: string): Promise<SessionOpenOutcome> {
	try {
		return await open(sessionId);
	} catch (error) {
		return isConnectionNotReadyError(error) ? { status: "transient", error } : { status: "failed", error };
	}
}

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
		const outcome = await settleOpen(options.open, options.sessionId);
		if (outcome.status === "opened") return { status: "opened", attempts, error: null };
		if (outcome.status === "superseded") return { status: "superseded", attempts, error: null };
		if (outcome.status === "failed") return { status: "failed", attempts, error: outcome.error };
		error = outcome.error;
		if (attempts >= maxAttempts) break;
		await wait(reopenRetryDelay(attempts));
	}
	return { status: "exhausted", attempts, error };
}

export interface SessionOpenHooks {
	/** Make this session the current intent. Called by `open` before the first
	 *  `wanted` check; the attempt must never be the thing that records it. */
	select: (sessionId: string) => void;
	/** One open attempt; the scheduler re-issues it with backoff. */
	open: (sessionId: string) => Promise<SessionOpenOutcome>;
	/** The session the user currently wants; null on the welcome page. */
	wanted: () => string | null;
	/** Ran out of bounded attempts: return to the welcome page with the reason. */
	abandon: (sessionId: string, error: unknown) => void;
	/** Injectable for tests; a real timer by default. */
	wait?: (ms: number) => Promise<void>;
	maxAttempts?: number;
}

/**
 * Owns every open intent for the app, so a user open and the reconnect restore
 * cannot undercut each other.
 *
 * `open` is the user's pick: it records the intent through `select` before the
 * first `wanted` check, because an intent recorded only inside the attempt
 * would let the run cancel itself before that attempt ever runs (the reported
 * "click another session, no request" failure). `restore` deliberately does
 * not record anything — it only re-opens a session the screen already shows,
 * and stops immediately when the user has moved on.
 *
 * Every call starts a new run and supersedes the previous one. A replaced run
 * stops before its next attempt (never after), which is what keeps the newest
 * intent from inheriting a cancellation: the run it replaced cannot fail
 * silently and leave the screen claiming a session nobody is fetching. The
 * winner retries on its own bounded schedule and falls back to the visible
 * failure through `abandon` only when the attempts are used up.
 */
export class SessionOpenScheduler {
	#generation = 0;
	readonly #hooks: SessionOpenHooks;

	constructor(hooks: SessionOpenHooks) {
		this.#hooks = hooks;
	}

	/** User-initiated open (row pick, create, deep link, tab): commits the pick
	 *  first, then retries on the bounded schedule. */
	open(sessionId: string): Promise<SessionReopenResult> {
		this.#hooks.select(sessionId);
		return this.#start(sessionId);
	}

	/** Reconnect restore of the session already on screen; never invents intent. */
	restore(sessionId: string): Promise<SessionReopenResult> {
		return this.#start(sessionId);
	}

	#start(sessionId: string): Promise<SessionReopenResult> {
		const generation = ++this.#generation;
		const stillWanted = (): boolean => this.#generation === generation && this.#hooks.wanted() === sessionId;
		return runSessionReopen({
			sessionId,
			open: this.#hooks.open,
			stillWanted,
			wait: this.#hooks.wait,
			maxAttempts: this.#hooks.maxAttempts,
		}).then(result => {
			if (result.status === "exhausted" && stillWanted()) this.#hooks.abandon(sessionId, result.error);
			return result;
		});
	}
}
