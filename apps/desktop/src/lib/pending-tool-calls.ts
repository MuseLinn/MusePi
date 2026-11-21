/** One unanswered tool call as the daemon reports it (`session.pendingToolCalls`). */
export interface PendingToolCallWire {
	toolName: string;
	toolCallId?: string | null;
	/** The command or path the call touched, when its arguments carried one. */
	summary?: { kind: "command" | "path"; value: string } | null;
}

/** A resume notice for a branch that ended mid-tool-call. */
export interface PendingToolCallsNotice {
	/** How many tool calls never received a result. */
	count: number;
	/** Their names and targets, joined for one line. */
	calls: string;
	/** Content identity: dismissing only dismisses this notice. */
	signature: string;
}

/**
 * The TUI's resume warning, as data the GUI renders in its own words.
 *
 * The daemon answers `session.pendingToolCalls` from the persisted branch; the
 * TUI prints the same diagnostic at `--continue`/`--resume`. Only an idle
 * session can have a genuinely abandoned call — while the agent runs, a call
 * without a result is in flight, so the caller suppresses this then.
 */
export function pendingToolCallsNotice(calls: readonly PendingToolCallWire[]): PendingToolCallsNotice | null {
	if (calls.length === 0) return null;
	const described = calls
		.map(call => {
			const target = call.summary ? `${call.summary.kind} \`${call.summary.value}\`` : undefined;
			return [call.toolName, target].filter(Boolean).join(" · ");
		})
		.join(", ");
	return { count: calls.length, calls: described, signature: `${calls.length}|${described}` };
}
