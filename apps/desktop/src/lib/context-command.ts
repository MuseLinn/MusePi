/**
 * GUI-native /context command detection. Typing /context in the composer
 * shows a categorized context-usage dialog (TUI /context panel parity)
 * instead of sending the command to the agent (whose reply is ANSI text).
 */
export function isContextCommand(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/context" || trimmed.startsWith("/context ");
}

/** The message half split by source: what the reader typed, what the harness
 *  injected, and what the model or its tools produced. */
interface MessageSourceView {
	userMessages: number;
	systemReminders: number;
	compactionSummaries: number;
	modelReplies: number;
	thinking: number;
	toolCalls: number;
	toolResults: number;
}

/** Category breakdown served by session.contextUsage (daemon adds the
 *  full ContextUsageBreakdown the TUI /context panel renders). */
export interface ContextBreakdownView {
	contextWindow: number;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
	/** Present when the daemon splits the message half; the panel then lists
	 *  these rows instead of one aggregate "messages" row. */
	messagesBySource?: MessageSourceView;
	/** Autocompact reserve (daemon computes from the compaction strategy). */
	autoCompactBufferTokens?: number;
	/** Window left after used + autocompact buffer. */
	freeTokens?: number;
}
