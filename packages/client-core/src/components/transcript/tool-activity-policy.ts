/**
 * One decision for every tool call the transcript draws.
 *
 * The two reading preferences (`display.hideToolActivity`, `toolCallSummary`)
 * used to be intersected at each call site — the run memo, the fold's default
 * open state, the toolCall block, the tail tools row — so a change to either
 * had to be found in four places and could disagree with itself. They are read
 * once here and the renderer consumes capabilities.
 *
 * `lane` exists because the two lanes will want different answers: a workbench
 * session is a coding agent whose tool calls ARE the work, while a bot lane
 * session reads as a conversation where the mascot already says that work is
 * happening. Until the bot lane ships both lanes read the same value, and the
 * seam is a parameter rather than a second copy of this logic.
 *
 * The failure rule is the important one: hiding tool activity must never hide a
 * call that failed. Hiding it turns a broken step into silence, which is how a
 * user loses the one fact they needed. `toolRowHidden` is therefore the single
 * place that decides, and it always keeps failures.
 */
import type { ToolResultLike } from "../../tool-render/types";

/** Which lane a transcript belongs to. Values are the daemon's agent-role ids
 *  where they exist; `workbench` is the main coding session. */
export type ToolLane = "workbench" | "bot";

export interface ToolActivityPolicy {
	/** Hide tool call cards entirely (process not shown in the transcript). */
	readonly hidden: boolean;
	/** Collapse consecutive work rows into one summary line. */
	readonly summarize: boolean;
	/** Read the lane's own preference, or the shared one until it exists. */
	readonly lane: ToolLane;
}

export interface ToolActivityPreferences {
	/** `display.hideToolActivity` — the workbench's answer. */
	hideToolActivity: boolean;
	/** `display.hideToolActivity.bot` — the bot lane's answer. Unset means the
	 *  bot lane hides: its conversation, not its process, is the product. */
	hideBotToolActivity?: boolean;
	/** `display.toolCallSummary` — grouping consecutive work rows. */
	toolCallSummary: boolean;
}

/**
 * Resolve the policy for one lane. `bot` defaults to hidden even when the
 * workbench shows everything, because the two lanes answer different questions:
 * "what did it run" is the workbench's content and the bot's noise.
 */
export function toolActivityPolicy(
	preferences: ToolActivityPreferences,
	lane: ToolLane = "workbench",
): ToolActivityPolicy {
	const hidden = lane === "bot" ? (preferences.hideBotToolActivity ?? true) : preferences.hideToolActivity;
	return {
		lane,
		hidden,
		// A summary is itself tool activity: with the cards hidden, a summary line
		// would be the only trace left and would read as a missing card.
		summarize: preferences.toolCallSummary && !hidden,
	};
}

/** A failed call is the reason the turn went wrong, so it is never "process". */
export function toolResultFailed(result: ToolResultLike | undefined): boolean {
	return result?.isError === true;
}

/**
 * Whether one tool call row draws nothing. The caller passes the result it
 * already resolved, so this never re-reads the transcript.
 */
export function toolRowHidden(policy: ToolActivityPolicy, result: ToolResultLike | undefined): boolean {
	if (!policy.hidden) return false;
	return !toolResultFailed(result);
}
