/**
 * Insert the plain-text half of a clipboard payload at the caret of a
 * controlled textarea.
 *
 * A clipboard that carries BOTH text and an image (copying from Word, a chat
 * app, or a browser selection with an inline picture) used to lose its text:
 * the image branch calls `preventDefault()` to keep the chip pipeline in
 * charge, and the browser's own insertion never ran. `setRangeText` +
 * an `input` event is the same mechanism the long-paste citation uses, so the
 * controlled value and the caret land exactly where a native paste would.
 */
export function insertPastedPlainText(el: HTMLTextAreaElement | null, text: string): void {
	if (!el || text.length === 0) return;
	const start = el.selectionStart ?? el.value.length;
	const end = el.selectionEnd ?? start;
	el.setRangeText(text, start, end, "end");
	// `setRangeText`'s selection mode is not portable (happy-dom jumps to the
	// document end); place the caret after the insertion explicitly.
	el.selectionStart = el.selectionEnd = start + text.length;
	el.dispatchEvent(new Event("input", { bubbles: true }));
}
