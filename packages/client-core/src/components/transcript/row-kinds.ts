/**
 * Transcript row classification — the shared vocabulary of the M1 projection.
 *
 * Owned in its own module (not inside render-units.ts) because BOTH the turn
 * projection (render-units.ts) and the completed-round fold (round-collapse.ts)
 * classify rows — a cycle would form if either imported the other. Keeping the
 * predicate here means the fold's "what stays visible" exemptions and the
 * render unit buckets can never drift apart.
 *
 * Semantics per design doc docs/archive/0.5.0-m1-transcript-design.md §A/§C.
 */
import type { SessionEntry } from "@musepi/pi-wire";

/** Row classes the M1 projection distinguishes (design doc §A/§C). */
export type TranscriptRowKind =
	/** Turn-start user prompt (or a displayed advisor note acting as one). */
	| "user"
	/** Assistant message carrying at least one non-empty text block — the
	 *  turn's visible reply body. Never folded. */
	| "assistantText"
	/** Process rows: toolCall-only / thinking-only assistant messages,
	 *  toolResult and bashExecution entries — the foldable working span. */
	| "work"
	/** Turn accompaniment that never folds: retry_failure / async-result
	 *  custom messages (design doc §C tail rows). */
	| "tail"
	/** Hook invocation rows (customType `hook` / `hook:*`) — turn-local audit
	 *  info, never folded, mono presentation. Producer: coding-agent's hooks
	 *  engine (see render-units module header); prefix convention enforced in
	 *  M2. */
	| "hook"
	/** Timeline boundaries: compaction / branch_summary / model_change /
	 *  thinking_level_change. */
	| "boundary"
	/** Any other displayed custom_message (advisor, ttsr, irc…). */
	| "custom";

/** customTypes rendered as turn tail rows (design doc §C). */
export const TAIL_CUSTOM_TYPES = new Set(["retry_failure", "async-result"]);

/** customType naming convention for hook invocation rows — matches the hook
 *  capability's `hook:<type>:<tool>:<name>` extension-id namespace. */
export function isHookCustomType(customType: string): boolean {
	return customType === "hook" || customType.startsWith("hook:");
}

/** True when the assistant message carries at least one non-empty text block. */
export function hasTextBlock(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		b =>
			typeof b === "object" &&
			b !== null &&
			(b as { type?: string }).type === "text" &&
			typeof (b as { text?: string }).text === "string" &&
			(b as { text?: string }).text!.trim().length > 0,
	);
}

/** Tool that posts a user-visible progress update mid-turn. */
export const PROGRESS_UPDATE_TOOL_NAME = "notify_user";

/**
 * A progress update is turn CONTENT, not process noise: the round fold keeps
 * the carrier row visible, and tool runs break around it so it never collapses
 * into a "读取了 N 个文件" summary. The assistant carrier owns the card; its
 * toolResult row carries no body and folds with the rest.
 */
export function isProgressUpdateRow(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const message = entry.message;
	if (message.role === "assistant") {
		return (
			Array.isArray(message.content) &&
			message.content.some(block => block?.type === "toolCall" && block.name === PROGRESS_UPDATE_TOOL_NAME)
		);
	}
	return message.role === "toolResult" && message.toolName === PROGRESS_UPDATE_TOOL_NAME;
}

/** Deterministic row classification for one transcript entry. */
export function classifyTranscriptRow(entry: SessionEntry): TranscriptRowKind {
	if (entry.type === "message") {
		const m = entry.message;
		if (m.role === "user") return "user";
		if (m.role === "assistant") return hasTextBlock((m as { content?: unknown }).content) ? "assistantText" : "work";
		// toolResult / bashExecution (and any future work-role message)
		return "work";
	}
	if (entry.type === "custom_message") {
		if (TAIL_CUSTOM_TYPES.has(entry.customType)) return "tail";
		if (isHookCustomType(entry.customType)) return "hook";
		return "custom";
	}
	return "boundary";
}
