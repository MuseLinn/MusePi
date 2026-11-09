/** Wire shapes this settings page reads. Declared locally (not imported from
 *  app.tsx) so the compiled plugin carries one small structural contract
 *  instead of the shell's component types. */

/** Session-file tail verdict as `session.list` derives it. */
export type SessionLifecycle = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

/** One `session.list` row (fields this page reads). */
export interface SessionListRow {
	id: string;
	title?: string;
	cwd?: string;
	timestamp?: string;
	updatedAt?: string;
	messageCount?: number;
	/** A live session with a running agent turn. */
	working?: boolean;
	/** Lifecycle verdict read from the transcript tail. */
	status?: SessionLifecycle;
	/** Auxiliary session rows stay out of the managed conversation list. */
	subagent?: boolean;
	advisor?: boolean;
}

/** One `session.search` / `history.messages` row (content already flattened
 *  to text daemon-side for search, raw JSON blocks for transcript reads). */
export interface SessionMessage {
	sessionId: string;
	seq: number;
	role: string;
	model: string | null;
	content: string;
	timestamp: number;
}

export interface SessionSearchResult {
	matches: SessionMessage[];
	sessions: Array<{ sessionId: string; messageCount: number }>;
}

/** `session.lastPrompts`: newest user message content per session id. */
export type SessionLastPrompts = Record<string, string>;
