/**
 * Transcript row classification — the shared vocabulary of the M1 projection.
 *
 * Owned in its own module (not inside render-units.ts) because BOTH the turn
 * projection (render-units.ts) and the completed-round fold (round-collapse.ts)
 * classify rows — a cycle would form if either imported the other. Keeping the
 * predicate here means the fold's "what stays visible" exemptions and the
 * render unit buckets can never drift apart.
 *
 * Semantics per design doc docs/review/0.5.0-m1-transcript-design.md §A/§C.
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
