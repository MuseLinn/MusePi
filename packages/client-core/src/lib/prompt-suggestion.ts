/**
 * Next-input candidate: a prediction of the message the user is most likely to
 * send next, produced by the daemon after a turn completes and offered in an
 * empty composer.
 *
 * One suggestion per session, held outside React so the daemon event handler
 * can write it without a component mounted. The composer reads it through
 * {@link subscribePromptSuggestions}; only an empty, idle, writable composer
 * shows it, and accepting is a plain draft fill — the user still edits or
 * sends it themselves.
 *
 * Session-scoped on purpose: switching sessions must never carry a candidate
 * into another conversation, where it would be answering the wrong turn.
 */

const suggestions = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

/** Publish the candidate for a session; an empty string clears it instead. */
export function setPromptSuggestion(sessionId: string, suggestion: string): void {
	const text = suggestion.trim();
	if (!sessionId) return;
	if (!text) {
		clearPromptSuggestion(sessionId);
		return;
	}
	if (suggestions.get(sessionId) === text) return;
	suggestions.set(sessionId, text);
	emit();
}

/** Drop the candidate — the user acted, or a newer turn replaced its source. */
export function clearPromptSuggestion(sessionId: string): void {
	if (!suggestions.delete(sessionId)) return;
	emit();
}

export function getPromptSuggestion(sessionId: string): string | null {
	return suggestions.get(sessionId) ?? null;
}

export function subscribePromptSuggestions(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** What the composer must satisfy before a candidate may stand in for its placeholder. */
export interface PromptSuggestionSlot {
	/** The draft is empty — nothing typed, nothing attached as text. */
	draftEmpty: boolean;
	/** The composer can accept a draft at all (read-only and draft screens cannot). */
	writable: boolean;
	/** A turn is running, so any candidate describes a conversation already left behind. */
	busy: boolean;
	/** Another surface owns the input (an ask dialog, a voice capture). */
	blocked: boolean;
}

/**
 * The candidate to display, or null when the composer must show its own
 * placeholder. Kept beside the store so both composers (`apps/desktop` and the
 * guest/mobile shell) answer this identically instead of drifting apart.
 */
export function visiblePromptSuggestion(suggestion: string | null, slot: PromptSuggestionSlot): string | null {
	if (!suggestion) return null;
	if (!slot.draftEmpty || !slot.writable || slot.busy || slot.blocked) return null;
	return suggestion;
}
