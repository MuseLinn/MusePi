/**
 * Connection state — what the shell is doing about the daemon, as one value.
 *
 * The boot gate used to be `if (!rpc)`: a deliberate disconnect, a daemon
 * that never answered, and a first launch with nothing configured all landed
 * on the same 无法连接本地守护进程 page. The states below separate those
 * causes so each one can render its own surface:
 *
 *  - `connected`          — the RPC client is open.
 *  - `starting`           — an attempt is in flight (boot splash / connect).
 *  - `disconnected-by-user` — the user pressed 断开. Nothing failed.
 *  - `unreachable`        — an attempt was made and it failed.
 *  - `unconfigured`       — no target has ever been chosen (first launch).
 *
 * The split is what makes the reported bug impossible: the failure surface is
 * reachable only from `unreachable`, so a deliberate disconnect can never show
 * 无法连接 again, and the calm manager can never stand in for a failed attempt.
 */

/** Facts the shell has when it decides what to render. */
export interface ConnectionFacts {
	/** The RPC client is open and the daemon answered. */
	connected: boolean;
	/** An attempt is in flight right now. */
	attempting: boolean;
	/** The user pressed 断开 (never cleared by a failed attempt). */
	disconnectedByUser: boolean;
	/** The last attempt ended in an error. */
	lastAttemptFailed: boolean;
	/**
	 * The user has stored at least one row of their own.
	 *
	 * Deliberately not "the list is non-empty": the built-in local row is always
	 * present, so counting it would make every install configured and leave
	 * `unconfigured` unreachable. A fresh install is unconfigured until the user
	 * stores a row or an attempt fails.
	 */
	hasTargets: boolean;
}

export type ConnectionState = "connected" | "starting" | "disconnected-by-user" | "unreachable" | "unconfigured";

/**
 * Resolve the surface to show. Order is deliberate: a live connection wins
 * over everything (an in-flight probe of another target must not hide the
 * session the user is reading), then an explicit user disconnect wins over a
 * stale error from an earlier attempt, and only then does a failure count.
 */
export function deriveConnectionState(facts: ConnectionFacts): ConnectionState {
	if (facts.connected) return "connected";
	if (facts.attempting) return "starting";
	if (facts.disconnectedByUser) return "disconnected-by-user";
	if (facts.lastAttemptFailed) return "unreachable";
	if (!facts.hasTargets) return "unconfigured";
	return "disconnected-by-user";
}

/** The state whose failure copy ("cannot reach…") is allowed to render. */
export function showsFailureCopy(state: ConnectionState): boolean {
	return state === "unreachable";
}

/** States that show the calm connection manager instead of an error page. */
export function showsManager(state: ConnectionState): boolean {
	return state === "disconnected-by-user" || state === "unconfigured";
}
