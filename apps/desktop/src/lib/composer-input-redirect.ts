/**
 * Type anywhere, land in the composer.
 *
 * With nothing focused — the usual state after scrolling the conversation, or
 * after switching back to the window — a keystroke should start a message, not
 * do nothing. This routes printable keys and pastes into the session composer.
 *
 * The whole value is in what it must NOT steal, and each exclusion is a way a
 * naive version breaks the app:
 *
 *  - the target already takes text (a field, a textarea, a page, an editor);
 *  - the target is an interactive control, where Space and letters press the
 *    button or open the link the user just tabbed to;
 *  - a floating layer is up (dialog, menu, settings, the /btw card), so typing
 *    belongs to it;
 *  - the user has text selected, because typing over a selection starts an
 *    annotation rather than a message;
 *  - the key is a modifier chord or an IME composition.
 *
 * 宿主是原生 textarea（非 CodeMirror 视图）。
 */

const EDITABLE_SELECTOR = [
	"input",
	"textarea",
	"select",
	"iframe",
	"webview",
	'[contenteditable=""]',
	'[contenteditable="true"]',
	'[contenteditable="plaintext-only"]',
	'[role="textbox"]',
].join(",");

/**
 * Keys on these keep their own meaning: Space and letters press a button,
 * follow a link, or walk a list.
 */
const INTERACTIVE_SELECTOR = [
	"button",
	"a[href]",
	"summary",
	'[role="button"]',
	'[role="checkbox"]',
	'[role="combobox"]',
	'[role="link"]',
	'[role="listbox"]',
	'[role="menuitem"]',
	'[role="option"]',
	'[role="radio"]',
	'[role="slider"]',
	'[role="switch"]',
	'[role="tab"]',
].join(",");

/**
 * While any of these is on screen, typing belongs to it.
 *
 * Lists and popper wrappers stay out on purpose: the turn rail is a list that
 * stays on screen, and a tooltip under the pointer is a popper — treating
 * either as a layer would silently disable typing-anywhere everywhere.
 */
const FLOATING_LAYER_SELECTOR = [
	'[role="dialog"]',
	'[role="alertdialog"]',
	'[role="menu"]',
	'[data-slot="select-content"][data-open]',
	'[data-settings-view="true"]',
	'[data-btw-composer="true"]',
].join(",");

function isElement(target: EventTarget | null): target is Element {
	return target instanceof Element;
}

function hasFloatingLayer(): boolean {
	for (const layer of document.querySelectorAll(FLOATING_LAYER_SELECTOR)) {
		// A `display:none` dialog is still in the DOM; only a laid-out one is up.
		if (layer.getClientRects().length > 0) return true;
	}
	return false;
}

function hasTextSelection(): boolean {
	const selection = window.getSelection();
	return Boolean(selection && !selection.isCollapsed);
}

function takesInputItself(element: Element | null): boolean {
	return Boolean(element?.closest(EDITABLE_SELECTOR) ?? element?.closest(INTERACTIVE_SELECTOR));
}

/** Whether a redirect may happen at all for this event. */
export function isComposerRedirectTarget(event: Event): boolean {
	if (event.defaultPrevented) return false;
	// A field, a page or a control takes its own input.
	if (isElement(event.target) && takesInputItself(event.target)) return false;
	if (hasFloatingLayer()) return false;
	// Typing over a transcript selection starts a comment/annotation.
	if (hasTextSelection()) return false;
	return true;
}

/** The composer a redirect should land in: the on-screen session textarea. */
export function findComposerTextarea(): HTMLTextAreaElement | null {
	for (const el of document.querySelectorAll<HTMLTextAreaElement>("textarea[data-composer-input]")) {
		if (el.getClientRects().length > 0) return el;
	}
	return null;
}

/** Insert at the caret end and focus, the way typing would. */
function insertInto(ta: HTMLTextAreaElement, text: string): void {
	ta.focus();
	const end = ta.value.length;
	ta.setSelectionRange(end, end);
	// A dispatched input event keeps every existing onChange path working
	// (autosize, draft persistence, slash/mention detection).
	ta.setRangeText(text, end, end, "end");
	ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Route a printable key into the composer.
 *
 * @returns whether the key was consumed — the caller uses this to avoid
 *   double-handling it.
 */
export function redirectKeyToComposer(event: KeyboardEvent): boolean {
	// A single character with no chord: chords are app shortcuts, and a bare
	// modifier has no text.
	if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false;
	// An IME composition is mid-word; stealing it would lose the input.
	if (event.isComposing) return false;
	if (!isComposerRedirectTarget(event)) return false;
	const ta = findComposerTextarea();
	if (!ta) return false;
	event.preventDefault();
	insertInto(ta, event.key);
	return true;
}

/**
 * Route a paste into the composer.
 *
 * The native paste is replayed on the textarea so it goes through the
 * composer's own handling — attachments, large-text gating, file mentions —
 * rather than pasting a bare string that skips all of it.
 */
export function redirectPasteToComposer(event: ClipboardEvent): boolean {
	const data = event.clipboardData;
	if (!data || !isComposerRedirectTarget(event)) return false;
	const ta = findComposerTextarea();
	if (!ta) return false;
	event.preventDefault();
	ta.focus();
	const replay = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
	ta.dispatchEvent(replay);
	// Nothing consumed the replay (no handler on a synthetic event): fall back
	// to inserting the plain text so the paste is never silently dropped.
	if (!replay.defaultPrevented) {
		const text = data.getData("text/plain");
		if (text) insertInto(ta, text);
	}
	return true;
}
