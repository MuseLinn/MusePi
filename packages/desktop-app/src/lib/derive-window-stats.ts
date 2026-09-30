import type { AssistantMessage, SessionEntry, UserMessage } from "@musepi/pi-wire";

/**
 * Visible-window performance fold for the composer stats row (§5w).
 *
 * The daemon serves no per-turn timing projection, so the time pill answers
 * "what is on screen" — a pure fold over the chat surface's visible entry
 * window. Field names deliberately mirror dsh's `WindowStats`
 * (`StatsPills.tsx`, dsh-v0.2.0-rc.1) so a future durable projection swaps
 * in wholesale. Token figures do NOT ride this fold: they come from the
 * daemon's durable `session.contextUsage` projection (Composer state), so
 * paging/compaction never move them.
 */
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
function isSettledAssistant(msg: AssistantMessage): boolean {
	return typeof msg.stopReason === "string" && msg.stopReason.length > 0;
}

/**
 * Fold the visible entry window into display totals.
 *
 * Contract: O(n) over the window; a streaming delta on an unsettled entry
 * changes nothing (unsettled assistants are skipped, user/toolResult rows
 * carry no stream-mutated timing fields the fold reads — UserMessage.synthetic
 * and ToolResultMessage.toolCallId/timestamp are send-time constants).
 * Paging the window changes the numbers by definition (the fold answers
 * "what is on screen"); the durability guarantee applies only to the
 * projection-backed token figures.
 */
export function deriveWindowStats(entries: readonly SessionEntry[]): WindowStats {
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
		const msg = entry.message;
		if (msg.role === "user") {
			if (!(msg as UserMessage).synthetic) turns += 1;
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
			for (const part of msg.content) {
				if (part.type === "toolCall") callTimeById.set(part.id, msg.timestamp);
			}
			continue;
		}
		if (msg.role === "toolResult") {
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
 * degrades to a plain reading with no popover (dsh contract, §5w). */
export function hasAnyTiming(stats: WindowStats): boolean {
	return stats.llmMs > 0 || stats.toolMs > 0 || stats.ttftSteps > 0 || stats.decodeMs > 0;
}

/** Decode speed in tokens/second; null when no decode-timed step exists. */
export function decodeTokensPerSecond(stats: WindowStats): number | null {
	return stats.decodeMs > 0 ? stats.decodeTokens / (stats.decodeMs / 1000) : null;
}

/** Compact token count (128K / 45.2M) for pill surfaces; exact counts in
 * popovers go through toLocaleString instead. */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

/** Compact duration: 45.2s under a minute, 2m42s from there on (dsh parity). */
export function formatDurationMs(ms: number): string {
	const s = ms / 1000;
	if (s < 60) return `${Math.round(s * 10) / 10}s`;
	const whole = Math.round(s);
	return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** Props the memoized stats row renders from. */
export interface StatsRowProps {
	stats: WindowStats;
	/** Durable projection summary (session.contextUsage.usage); null before the first fetch. */
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
		cacheHitRate: number | null;
	} | null;
	mode: "detailed" | "compact";
}

/**
 * memo() comparator — the streaming guard (§5w performance boundary). Field
 * equality, not identity: a stream delta produces a fresh entries array but
 * identical derived numbers, and the row must not re-render on those ticks.
 */
export function statsRowPropsEqual(a: StatsRowProps, b: StatsRowProps): boolean {
	if (a.mode !== b.mode) return false;
	const sa = a.stats;
	const sb = b.stats;
	if (
		sa.turns !== sb.turns ||
		sa.steps !== sb.steps ||
		sa.llmMs !== sb.llmMs ||
		sa.toolMs !== sb.toolMs ||
		sa.ttftMs !== sb.ttftMs ||
		sa.ttftSteps !== sb.ttftSteps ||
		sa.decodeMs !== sb.decodeMs ||
		sa.decodeTokens !== sb.decodeTokens
	) {
		return false;
	}
	const ua = a.usage;
	const ub = b.usage;
	if (ua === null || ub === null) return ua === ub;
	return (
		ua.input === ub.input &&
		ua.output === ub.output &&
		ua.cacheRead === ub.cacheRead &&
		ua.cacheWrite === ub.cacheWrite &&
		ua.totalTokens === ub.totalTokens &&
		ua.cost === ub.cost &&
		ua.cacheHitRate === ub.cacheHitRate
	);
}

/** Billed input buckets + output — the usage pill's「总 tok」figure. */
export function billedTotalTokens(usage: NonNullable<StatsRowProps["usage"]>): number {
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/** True when the session has billed any tokens — gates the usage pill. */
export function hasTokenActivity(usage: NonNullable<StatsRowProps["usage"]> | null): boolean {
	return usage !== null && (usage.input + usage.cacheRead + usage.cacheWrite > 0 || usage.output > 0);
}

/**
 * Cache-hit share of billed prompt-side input; null when nothing was billed
 * input-side (the projection's cacheHitRate is null until the first cache
 * read — both mean "no figure to show").
 */
export function cacheHitPercent(usage: NonNullable<StatsRowProps["usage"]>): string | null {
	if (usage.cacheHitRate === null) return null;
	return usage.cacheHitRate.toFixed(1);
}
