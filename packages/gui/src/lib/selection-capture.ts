/**
 * Global selection capture (openchamber addSelectionToChat parity): turn
 * whatever the user currently has selected — a text control, a textarea,
 * or a plain DOM range — into chat-ready plain text. Excludes selections
 * inside the chat composer itself so Cmd/Ctrl+L never re-quotes what you
 * are typing (the composer is identified by [data-chat-input="true"], the
 * same host marker openchamber uses).
 *
 * The GUI has no CodeMirror editor (openchamber's first capture branch),
 * so capture order is: text control → DOM range.
 */

const CHAT_INPUT_HOST_SELECTOR = "[data-chat-input=\"true\"]";

const isInsideChatComposer = (node: Node | null): boolean => {
	if (!node) return false;
	const element = typeof (node as Element).closest === "function" ? (node as Element) : node.parentElement;
	return Boolean(element?.closest(CHAT_INPUT_HOST_SELECTOR));
};

const trimSelectionValue = (value: string): string => value.replace(/\r\n?/g, "\n").trim();

/** Read the selection of a focused text control (input/textarea) that is
 *  NOT the chat composer. Collapses the selection so a duplicate delivery
 *  cannot re-capture the same range (openchamber parity). */
const readTextControlSelection = (element: Element): string | null => {
	if (isInsideChatComposer(element)) return null;
	const tag = element.tagName?.toLowerCase();
	const control = element as HTMLTextAreaElement | HTMLInputElement;
	if (tag === "textarea") {
		const start = control.selectionStart ?? 0;
		const end = control.selectionEnd ?? 0;
		const text = trimSelectionValue(control.value.slice(start, end));
		if (!text) return null;
		control.selectionStart = end;
		control.selectionEnd = end;
		return text;
	}
	if (tag === "input") {
		const type = control.type?.toLowerCase() ?? "text";
		if (!["text", "search", "url", "tel", "password"].includes(type)) return null;
		const start = control.selectionStart ?? 0;
		const end = control.selectionEnd ?? 0;
		const text = trimSelectionValue(control.value.slice(start, end));
		if (!text) return null;
		control.selectionStart = end;
		control.selectionEnd = end;
		return text;
	}
	return null;
};

const captureActiveElementSelection = (): string | null => {
	if (typeof document === "undefined") return null;
	const activeElement = document.activeElement;
	if (!activeElement || typeof (activeElement as Element).tagName !== "string") return null;
	return readTextControlSelection(activeElement as Element);
};

const captureDomSelection = (): string | null => {
	if (typeof window === "undefined") return null;
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
	const range = selection.getRangeAt(0);
	if (isInsideChatComposer(range.commonAncestorContainer)) return null;
	const text = trimSelectionValue(selection.toString());
	if (!text) return null;
	selection.removeAllRanges();
	return text;
};

/** Current non-composer selection as plain text, or null when nothing
 *  usable is selected. */
export function captureSelectionText(): string | null {
	return captureActiveElementSelection() ?? captureDomSelection();
}

/** Wrap a captured selection for the composer (openchamber parity: a md
 *  code fence keeps the structure and prevents markdown bleed-through). */
export function wrapSelectionForChat(markdown: string): string {
	const longestBacktickRun = Math.max(0, ...Array.from(markdown.matchAll(/`+/g), match => match[0].length));
	const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
	return `${fence}md\n${markdown}\n${fence}`;
}
