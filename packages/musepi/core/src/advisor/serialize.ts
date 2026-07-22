// ============================================================
// MusePi advisor — transcript serialization for the review model.
//
// Reuses the snapcompact serializer (¶-prefixed scopes, tool results
// merged into their call blocks, head-biased truncation) and adds an
// advisor-specific window policy: the newest context wins (tail-biased),
// while the original user ask survives as a head anchor so the reviewer
// can always judge drift against the actual request.
// Zero host imports.
// ============================================================

import { serializeConversation, type SnapMessage } from "../snapcompact/index.ts";

/** Default transcript budget sent to the review model. */
export const ADVISOR_DEFAULT_MAX_CONTEXT_CHARS = 60_000;
/** Per-tool-result cap inside the serialized transcript. */
export const ADVISOR_DEFAULT_TOOL_RESULT_MAX_CHARS = 1_500;
/** Cap for the first-user-message anchor kept when eliding. */
export const ADVISOR_HEAD_ANCHOR_CHARS = 400;

export interface AdvisorTranscriptOptions {
	/** Whole-transcript budget. Default 60000. */
	maxChars?: number;
	/** Per-tool-result cap. Default 1500. */
	toolResultMaxChars?: number;
	/** First-user-message anchor cap. Default 400. */
	headChars?: number;
}

function firstUserExcerpt(messages: SnapMessage[], maxChars: number): string {
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		const text =
			typeof msg.content === "string"
				? msg.content
				: msg.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join("");
		const trimmed = text.trim();
		if (!trimmed) continue;
		return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
	}
	return "";
}

/**
 * Serialize session messages into the review transcript. Under budget the
 * full serialization is returned; over budget the middle drops out: the
 * first user message stays as a `¶user:` anchor, an elision marker records
 * the cut, and the tail (newest turns) is kept, cut at a line boundary.
 */
export function buildAdvisorTranscript(messages: SnapMessage[], options?: AdvisorTranscriptOptions): string {
	const maxChars = Math.max(1_000, options?.maxChars ?? ADVISOR_DEFAULT_MAX_CONTEXT_CHARS);
	const full = serializeConversation(messages, {
		toolResultMaxChars: options?.toolResultMaxChars ?? ADVISOR_DEFAULT_TOOL_RESULT_MAX_CHARS,
	});
	if (full.length <= maxChars) return full;

	const anchor = firstUserExcerpt(messages, options?.headChars ?? ADVISOR_HEAD_ANCHOR_CHARS);
	const head = anchor ? `¶user:${anchor}\n\n` : "";
	// Reserve for head + marker (marker length varies with the digit count;
	// 60 chars is a safe upper bound) and keep the newest tail.
	const tailBudget = Math.max(0, maxChars - head.length - 60);
	const tail = full.slice(-tailBudget);
	const newline = tail.indexOf("\n");
	const trimmedTail = newline >= 0 ? tail.slice(newline + 1) : tail;
	const elided = full.length - trimmedTail.length;
	return `${head}[…earlier transcript elided (~${elided} chars)…]\n\n${trimmedTail}`;
}
