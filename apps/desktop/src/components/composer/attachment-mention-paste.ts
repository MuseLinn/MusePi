/**
 * Paste-intake mirror (Kimi desktop parity): a pasted image becomes a chip
 * AND, when the preference allows it, an ordinal token in the draft at the
 * caret — the same `@图片N` the chip's mention button inserts. The chip
 * stays the bytes; the token is the model-visible pointer.
 *
 * The token is plain text, so it rides draft persistence, copy/paste and the
 * highlight overlay for free. Insertion uses `setRangeText` + an `input`
 * CodeMirror receives one `replaceRange` transaction; the textarea fallback
 * keeps `setRangeText` + `input` for the same caret semantics.
 */
import type { ComposerEditorHandle } from "./editor-types";
import { ordinalMentionLabel, spliceMentionTokens } from "./mention-token";
import type { ComposerAttachment } from "./use-attachments";

/** Labels for the image chips this batch appended. Ordinals continue from
 *  the chips already staged at paste time; the hook appends, so batch order
 *  is chip order. */
export function pastedImageMentionLabels(added: readonly ComposerAttachment[], priorImageCount: number): string[] {
	return added
		.filter(chip => chip.kind === "image")
		.map((_, index) => ordinalMentionLabel("image", priorImageCount + index + 1));
}

/** Splice the labels at the editor caret as `@图片N ` tokens. */
export function insertPastedImageMentions(
	el: HTMLTextAreaElement | ComposerEditorHandle | null,
	added: readonly ComposerAttachment[],
	priorImageCount: number,
): void {
	if (!el) return;
	const labels = pastedImageMentionLabels(added, priorImageCount);
	if (labels.length === 0) return;
	const start = el.selectionStart;
	const end = el.selectionEnd;
	const { next, caret } = spliceMentionTokens(el.value, start, end, labels);
	if ("insertText" in el) {
		// CodeMirror: one transaction replaces the selection and leaves the
		// caret after the inserted tokens.
		el.replaceRange(start, end, next.slice(start, caret));
		return;
	}
	// `setRangeText` + `input` is the path the mixed-clipboard text insertion
	// already uses; React's value tracker does not swallow it.
	el.setRangeText(next.slice(start, caret), start, end, "end");
	el.selectionStart = el.selectionEnd = caret;
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Number of image chips staged before a new batch landed. */
export function imageChipCount(attachments: readonly ComposerAttachment[]): number {
	return attachments.filter(chip => chip.kind === "image").length;
}
