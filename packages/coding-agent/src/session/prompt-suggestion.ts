/**
 * Next-input suggestion policy: which turns qualify, and what counts as an
 * answer.
 *
 * These are the provider-neutral facts shared by the bundled
 * `prompt-suggestion` plugin. Timing, cancellation, the model call and
 * delivery belong to that plugin and the host, so this module stays pure and
 * testable without a session.
 */

import type { AgentMessage } from "@musepi/pi-agent-core";

/** Upper bound on a suggestion, matching the instruction's own limit. */
export const PROMPT_SUGGESTION_MAX_CHARS = 240;

/**
 * Read one `{show, message}` answer: the structured form the instruction asks
 * for, where `show` carries the "is there a grounded next move at all" decision
 * instead of leaving it to the model to emit a bare `null`.
 */
function structuredSuggestion(raw: string): string | null | undefined {
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
	const body = (fenced?.[1] ?? raw).trim();
	if (!body.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as { show?: unknown; message?: unknown };
	// "no" is an explicit decline — distinct from a malformed answer, which
	// falls back to the plain-text reading below.
	if (record.show === "no") return null;
	if (record.show !== "yes") return undefined;
	return typeof record.message === "string" ? record.message : null;
}

/**
 * Trim surrounding whitespace before publishing. Empty output and the literal
 * `null` decline the suggestion; the message content is otherwise preserved
 * verbatim so the candidate reads exactly as the model wrote it.
 *
 * A `{show, message}` answer is unwrapped first: a provider or model that
 * honours the structured form must not surface raw JSON in the composer, and
 * one that answers in plain text keeps working through the same entry point.
 */
export function promptSuggestionText(raw: string): string | null {
	const structured = structuredSuggestion(raw.trim());
	if (structured === null) return null;
	if (structured !== undefined) return promptSuggestionText(structured);
	const text = raw.trim();
	if (text === "" || text === "null") return null;
	return text.slice(0, PROMPT_SUGGESTION_MAX_CHARS);
}

/**
 * Only a turn that ended on a model-authored reply gets a suggestion. An
 * aborted or errored turn has no conversation to continue from, and a
 * suggestion attached to it would read as built on the failure.
 */
export function turnAllowsPromptSuggestion(messages: readonly AgentMessage[]): boolean {
	let lastAssistant: { stopReason?: string } | undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		lastAssistant = message as { stopReason?: string };
		break;
	}
	if (!lastAssistant) return false;
	return lastAssistant.stopReason !== "aborted" && lastAssistant.stopReason !== "error";
}
