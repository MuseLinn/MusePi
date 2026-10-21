/**
 * Visible-window performance fold for the composer stats row.
 *
 * Shared by the daemon (served on `session.contextUsage.windowStats`) and
 * any renderer that still folds locally. The fold answers "what is in this
 * entry window": token figures do NOT ride it — they come from the durable
 * `session.contextUsage` projection, so paging/compaction never moves them.
 * Field names are fixed display-contract names, so a future durable
 * projection swaps in wholesale without touching renderers.
 */

/**
 * Minimal structural view of a session entry that the fold reads.
 *
 * Deliberately wider than the wire `SessionEntry` union: the daemon folds its
 * own internal entry union (which adds credential-pin and similar rows), and
 * every field here is optional except the discriminator inputs the fold
 * actually consumes at runtime — `type`, `message.role`, and `timestamp` on
 * messages that time fields reference.
 */
export interface StatsFoldEntry {
	readonly type: string;
	readonly message?: unknown;
}

interface FoldMessage {
	role?: string;
	synthetic?: boolean;
	stopReason?: unknown;
	duration?: unknown;
	ttft?: unknown;
	timestamp: number;
	content?: unknown;
	usage?: { output?: number } | null;
	toolCallId?: string;
}

export interface WindowStats {
	/** Non-synthetic user messages in the window — each starts a turn. */
	turns: number;
	/** Settled assistant messages (`stopReason` present); streaming entries are not steps yet. */
	steps: number;
	/** Σ request wall time (AssistantMessage.duration) over settled steps. */
	llmMs: number;
	/** Σ paired tool wall time (toolResult.timestamp − host assistant timestamp); unpaired calls/results count nothing. */
	toolMs: number;
	/** Σ first-token latency over steps that record it. */
	ttftMs: number;
	/** Steps carrying a recorded TTFT. */
	ttftSteps: number;
	/** Σ decode wall time (duration − ttft) over steps carrying both. */
	decodeMs: number;
	/** Σ output tokens over the same decode-timed steps. */
	decodeTokens: number;
}

const EMPTY: WindowStats = {
	turns: 0,
	steps: 0,
	llmMs: 0,
	toolMs: 0,
	ttftMs: 0,
	ttftSteps: 0,
	decodeMs: 0,
	decodeTokens: 0,
};

/** Settled marker: the wire only fills stopReason when the request finished. */
function isSettledAssistant(msg: FoldMessage): boolean {
	return typeof msg.stopReason === "string" && msg.stopReason.length > 0;
}

/**
 * Fold an entry window into display totals.
 *
 * Contract: O(n) over the window; a streaming delta on an unsettled entry
 * changes nothing (unsettled assistants are skipped, user/toolResult rows
 * carry no stream-mutated timing fields the fold reads — UserMessage.synthetic
 * and ToolResultMessage.toolCallId/timestamp are send-time constants).
 * Paging the window changes the numbers by definition (the fold answers
 * "what is in this window"); the durability guarantee applies only to the
 * projection-backed token figures.
 */
export function deriveWindowStats(entries: readonly StatsFoldEntry[]): WindowStats {
	let turns = 0;
	let steps = 0;
	let llmMs = 0;
	let toolMs = 0;
	let ttftMs = 0;
	let ttftSteps = 0;
	let decodeMs = 0;
	let decodeTokens = 0;
	// toolCallId → the wall-clock time the call left the model (its host
	// assistant message's timestamp). Only calls whose host is in-window
	// enter the map; a result without an in-window host contributes nothing.
	const callTimeById = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as FoldMessage | undefined;
		if (!msg || typeof msg.role !== "string") continue;
		if (msg.role === "user") {
			if (!msg.synthetic) turns += 1;
			continue;
		}
		if (msg.role === "assistant") {
			if (!isSettledAssistant(msg)) continue;
			steps += 1;
			if (typeof msg.duration === "number") llmMs += Math.max(0, msg.duration);
			const ttft = msg.ttft;
			if (typeof ttft === "number") {
				ttftMs += Math.max(0, ttft);
				ttftSteps += 1;
				if (typeof msg.duration === "number") {
					const decode = Math.max(0, msg.duration - ttft);
					if (decode > 0) {
						decodeMs += decode;
						decodeTokens += Math.max(0, msg.usage?.output ?? 0);
					}
				}
			}
			const content = msg.content as { type: string; id?: string }[] | undefined;
			if (Array.isArray(content)) {
				for (const part of content) {
					if (part.type === "toolCall" && typeof part.id === "string") {
						callTimeById.set(part.id, msg.timestamp);
					}
				}
			}
			continue;
		}
		if (msg.role === "toolResult") {
			if (typeof msg.toolCallId !== "string") continue;
			const callTime = callTimeById.get(msg.toolCallId);
			if (callTime !== undefined) toolMs += Math.max(0, msg.timestamp - callTime);
		}
	}
	if (
		turns === 0 &&
		steps === 0 &&
		llmMs === 0 &&
		toolMs === 0 &&
		ttftMs === 0 &&
		ttftSteps === 0 &&
		decodeMs === 0 &&
		decodeTokens === 0
	) {
		return EMPTY;
	}
	return { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens };
}

/** True when the window carries no timing figure at all — the time pill then
 * degrades to a plain reading with no popover. */
export function hasAnyTiming(stats: WindowStats): boolean {
	return stats.llmMs > 0 || stats.toolMs > 0 || stats.ttftSteps > 0 || stats.decodeMs > 0;
}

/** Decode speed in tokens/second; null when no decode-timed step exists. */
export function decodeTokensPerSecond(stats: WindowStats): number | null {
	return stats.decodeMs > 0 ? stats.decodeTokens / (stats.decodeMs / 1000) : null;
}
