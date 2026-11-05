/** Wire shapes this settings page reads. Declared locally (not imported from
 *  app.tsx) so the compiled plugin carries one small structural contract
 *  instead of the shell's component types. */

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
	/** Auxiliary session rows stay out of the managed conversation list. */
	subagent?: boolean;
	advisor?: boolean;
}

/** One `session.search` match (already flattened to text daemon-side). */
export interface SessionSearchMatch {
	sessionId: string;
	seq: number;
	role: string;
	model: string | null;
	content: string;
	timestamp: number;
}

export interface SessionSearchResult {
	matches: SessionSearchMatch[];
	sessions: Array<{ sessionId: string; messageCount: number }>;
}
