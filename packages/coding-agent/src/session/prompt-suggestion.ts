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

/**
 * Trim surrounding whitespace before publishing. Empty output and the literal
 * `null` decline the suggestion; the message content is otherwise preserved
 * verbatim so the candidate reads exactly as the model wrote it.
 */
export function promptSuggestionText(raw: string): string | null {
	const text = raw.trim();
	if (text === "" || text === "null") return null;
	return text;
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
