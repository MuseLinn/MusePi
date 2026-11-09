/**
 * Composer draft storage, keyed by connection + session.
 *
 * The composer used to keep its text in component state only, and the shell
 * renders one composer for every session. Two consequences, both reported as
 * "the app feels wrong": a half-typed prompt followed the user into whatever
 * session they opened next (and would have been sent there), and an Android
 * process kill — routine when the WebView is backgrounded — silently threw the
 * draft away.
 *
 * Keys are `musepi.draft.<connection>::<session>`, where `<session>` is the
 * focused session id or the new-session sentinel. The connection part keeps
 * drafts apart across computers; the session part is what makes a draft
 * belong to one conversation instead of leaking into the next.
 */

const PREFIX = "musepi.draft.";

/** New-session slot: a draft typed before the session exists yet. */
export const NEW_SESSION_SLOT = "__new__";

/** Drafts are prompts, not documents — cap what a stray paste can persist. */
const MAX_DRAFT_CHARS = 20_000;

export function draftKey(scope: string, sessionId: string | null): string {
	return `${PREFIX}${scope}::${sessionId ?? NEW_SESSION_SLOT}`;
}

export function readDraft(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		// Private mode / storage disabled — the composer still works in memory.
		return "";
	}
}

export function writeDraft(key: string, text: string): void {
	try {
		if (text.length === 0) {
			localStorage.removeItem(key);
			return;
		}
		localStorage.setItem(key, text.slice(0, MAX_DRAFT_CHARS));
	} catch {
		// Quota exceeded or storage disabled — non-fatal, the draft stays local.
	}
}
