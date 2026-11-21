/**
 * Host-owned per-session read state: which completed turns the user has seen.
 *
 * This is the single authority for the session unread / failure markers. Every
 * client connected to the same host (desktop windows, the mini chat, the phone
 * web shell) renders the same answer, because the daemon owns the records and
 * persists them — a daemon restart does not resurrect notifications the user
 * already cleared, and a mark made on the phone clears the dot on the desktop.
 *
 * A record compares *completed turns* rather than message counts: a session is
 * unread while the last completed turn is newer than the turn the user read up
 * to. `manualUnread` pins a session unread; only an explicit mark-read clears
 * the pin, so an automatic read (a completion of a session that is on screen)
 * never silently undoes the user's decision.
 */

export interface SessionReadRecord {
	/** Monotonic count of agent runs observed completing on this host. */
	completedTurn: number;
	/** completedTurn value at the last explicit read. */
	readTurn: number;
	/** Whether the most recent completed turn ended in an error. */
	lastFailed: boolean;
	/** User pinned the session unread; an explicit read is the only clear. */
	manualUnread: boolean;
	/** ISO time of the most recent completion (ordering / diagnostics). */
	completedAt?: string;
}

/** Derived state handed to clients; `unread`/`failed` are the render facts. */
export interface SessionReadState {
	sessionId: string;
	unread: boolean;
	/** Show the failure marker: unread AND the latest completed turn failed. */
	failed: boolean;
	manualUnread: boolean;
	completedTurn: number;
	readTurn: number;
	completedAt?: string;
}

export function emptyReadRecord(): SessionReadRecord {
	return { completedTurn: 0, readTurn: 0, lastFailed: false, manualUnread: false };
}

/** Validate a persisted record; anything malformed degrades to an empty one. */
export function normalizeReadRecord(raw: unknown): SessionReadRecord {
	if (!raw || typeof raw !== "object") return emptyReadRecord();
	const record = raw as Record<string, unknown>;
	const count = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
	const completedTurn = count(record.completedTurn);
	return {
		completedTurn,
		readTurn: Math.min(count(record.readTurn), completedTurn),
		lastFailed: record.lastFailed === true,
		manualUnread: record.manualUnread === true,
		...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
	};
}

export function deriveReadState(sessionId: string, record: SessionReadRecord): SessionReadState {
	const unread = record.manualUnread || record.completedTurn > record.readTurn;
	return {
		sessionId,
		unread,
		failed: unread && record.lastFailed,
		manualUnread: record.manualUnread,
		completedTurn: record.completedTurn,
		readTurn: record.readTurn,
		...(record.completedAt ? { completedAt: record.completedAt } : {}),
	};
}

export interface TurnCompletion {
	failed: boolean;
	/** The session had a live subscriber when the run ended — someone is
	 *  looking at it, so this completion counts as read. */
	watched: boolean;
	at: string;
}

/**
 * Fold one finished agent run into the record. `watched` advances readTurn
 * (the transcript is on screen, so the new turn is seen) but never touches
 * `manualUnread`: a pinned session stays unread until an explicit read.
 */
export function applyTurnCompletion(record: SessionReadRecord, completion: TurnCompletion): SessionReadRecord {
	const completedTurn = record.completedTurn + 1;
	return {
		...record,
		completedTurn,
		lastFailed: completion.failed,
		completedAt: completion.at,
		readTurn: completion.watched ? completedTurn : record.readTurn,
	};
}

/** Explicit read: clears the manual pin and advances to the latest turn. */
export function applyMarkRead(record: SessionReadRecord): SessionReadRecord {
	return { ...record, readTurn: record.completedTurn, manualUnread: false };
}

/** Explicit manual unread: pins the session until the next explicit read. */
export function applyMarkUnread(record: SessionReadRecord): SessionReadRecord {
	return { ...record, manualUnread: true };
}
