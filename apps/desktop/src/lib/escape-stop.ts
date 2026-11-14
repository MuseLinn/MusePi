/**
 * Bare-Escape → interrupt-turn decision (TUI Esc parity, scoped).
 *
 * The desktop shell binds unmodified Escape to "stop the running turn"
 * (`session.abort` with the user-interrupt reason — the same one the TUI Esc
 * threads). That parity is deliberate, but an unscoped window-level binding
 * makes ANY Escape that reaches the window an interrupt: an Escape meant to
 * dismiss a header menu or composer popover whose own handler did not claim
 * the key, a key repeat, or a press aimed at a field that owns Escape
 * (session search, browser address bar, file rename). The turn then ends as
 * "Interrupted by user" for a keypress that had nothing to do with it.
 *
 * The interrupt is therefore gated on:
 *  - the event not already claimed (`defaultPrevented` — the owning surface
 *    closed on Escape and MUST mark it),
 *  - not an auto-repeat (holding Escape is one gesture, not many),
 *  - no Escape-owning surface under the event target,
 *  - a turn actually running: with nothing streaming there is no turn to
 *    interrupt, and aborting anyway stamps the session as user-interrupted,
 *    which latches advisor auto-resume suppression until the next prompt.
 */

/** Which surface, if any, owns the Escape that produced the event. */
export type EscapeOwner = "overlay" | "field" | null;

export interface EscapeStopInput {
	/** The owning surface already handled this key (its handler called preventDefault). */
	claimed: boolean;
	/** Escape-owning surface under the event target. */
	owner: EscapeOwner;
	/** Auto-repeat from a held key. */
	repeat: boolean;
	/** A turn is running (`snap.working`). */
	working: boolean;
}

/** Whether this Escape should interrupt the running turn. */
export function shouldEscapeStopTurn(input: EscapeStopInput): boolean {
	if (input.claimed || input.repeat) return false;
	if (input.owner !== null) return false;
	return input.working;
}

/** Dialogs, menus and listboxes own Escape while they are open. */
const OVERLAY_SELECTOR =
	'[role="dialog"], [role="listbox"], [role="menu"], [role="tooltip"], [aria-modal="true"], [data-escape-owner]';

/**
 * Fields own Escape unless they are the chat composer: dismissing a field
 * (search, rename, address bar) must not interrupt the turn, while Escape in
 * the composer keeps the TUI semantics (bare Esc = interrupt).
 */
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

/** The chat composer host — the ONE field where Escape means "interrupt". */
const CHAT_INPUT_HOST_SELECTOR = '[data-chat-input="true"]';

/**
 * Resolve the Escape owner from the event target (null = nothing owns it).
 *
 * The target is duck-typed rather than `instanceof Element`: a window- or
 * document-level key event carries an EventTarget with no `closest` (and no
 * DOM exists in the unit test realm), and both mean "nothing owns it".
 */
export function escapeOwner(target: EventTarget | null): EscapeOwner {
	const el = target as { closest?: (selector: string) => Element | null } | null;
	if (typeof el?.closest !== "function") return null;
	if (el.closest(OVERLAY_SELECTOR)) return "overlay";
	const field = el.closest(FIELD_SELECTOR);
	if (field && !field.closest(CHAT_INPUT_HOST_SELECTOR)) return "field";
	return null;
}
