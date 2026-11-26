/**
 * Connection presentation — one mapping from connection facts to what a user
 * sees, so every surface answers the same way.
 *
 * The shell already separates the *causes* (`state.ts`: connected, starting,
 * disconnected-by-user, unreachable, unconfigured). What it lacked is the
 * other half: a single place that turns those causes, plus a row's own facts,
 * into the five things a person actually recognises. Before this, three
 * surfaces each wrote their own version:
 *
 *  - the locations dialog's rows built a status sentence;
 *  - `ConnectionManager` built another for the same row;
 *  - the rail dot and the account menu inferred a third.
 *
 * They agreed often enough to look correct and drifted where it mattered —
 * a deliberate disconnect read as a failure in one place and as neutral text
 * in another. This module is the only mapping now; surfaces read `phase`,
 * `labelKey` and `tone` instead of deciding.
 *
 * The phase vocabulary is deliberately small and user-facing. Anything that
 * needs a decision ("needs an update", "needs a password") is `attention`,
 * never a new noun, and engineering words stay out of the labels.
 */

/** The five states a person needs to recognise. */
export type ConnectionPhase = "connected" | "connecting" | "idle" | "attention" | "failed";

/** Colour role, not a colour: the theme owns the value. */
export type ConnectionTone = "ok" | "busy" | "neutral" | "warn" | "error";

/** Facts about one row or about the shell, in the shape surfaces already hold. */
export interface ConnectionPresentationInput {
	/** The endpoint answered and the shell is talking to it. */
	connected: boolean;
	/** An attempt is in flight right now. */
	connecting?: boolean;
	/** The last attempt's error, when there was one. */
	lastError?: string | null;
	/** The managed process behind this row (tunnel, WSL daemon, container). */
	managed?: "starting" | "running" | "failed" | null;
}

export interface ConnectionPresentation {
	phase: ConnectionPhase;
	/** Locale key the surface renders; the copy lives in the locale files. */
	labelKey:
		| "settings.connectionStatusConnected"
		| "settings.connectionStatusConnecting"
		| "settings.connectionStatusUnknown"
		| "settings.connectionStatusFailed"
		| "settings.connectionNeedsAttention";
	tone: ConnectionTone;
}

/**
 * Resolve one presentation. Order matters and is the whole contract:
 *
 *  1. a live connection wins over anything else the row remembers, because a
 *     stale error beside a working endpoint is noise;
 *  2. a managed process that failed is `attention` — the user has a step to
 *     take, and calling it "failed" sends them looking for a network problem;
 *  3. an attempt in flight is `connecting`, never `failed`;
 *  4. a recorded error is `failed`;
 *  5. everything else is `idle`, which is neutral: a deliberate disconnect
 *     lands here and must not read as an error.
 */
export function connectionPresentation(input: ConnectionPresentationInput): ConnectionPresentation {
	if (input.connected) {
		return { phase: "connected", labelKey: "settings.connectionStatusConnected", tone: "ok" };
	}
	if (input.managed === "failed") {
		return { phase: "attention", labelKey: "settings.connectionNeedsAttention", tone: "warn" };
	}
	if (input.connecting || input.managed === "starting") {
		return { phase: "connecting", labelKey: "settings.connectionStatusConnecting", tone: "busy" };
	}
	if (input.lastError) {
		return { phase: "failed", labelKey: "settings.connectionStatusFailed", tone: "error" };
	}
	return { phase: "idle", labelKey: "settings.connectionStatusUnknown", tone: "neutral" };
}
