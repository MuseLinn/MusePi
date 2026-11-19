/**
 * The composer editor handle: the small surface the composers actually use.
 *
 * It intentionally mirrors the textarea members that already appear at call
 * sites (`value`, `selectionStart/End`, `setSelectionRange`, `focus`, `blur`)
 * so the CodeMirror migration does not turn into a rewrite of every voice,
 * completion, paste and draft path. DOM-specific helpers (`autosize`, pasted
 * text insertion) branch on `insertText` / `autosize` instead of casting.
 */
/** Caret or selection in document offsets. */
export interface ComposerSelection {
	start: number;
	end: number;
}

/** One painted token range. The caller owns token semantics; the editor only
 *  paints `className` and reads `mentionName` for the hover card. */
export interface EditorMark {
	from: number;
	to: number;
	className: string;
	mentionName?: string;
}

/** Attachment data behind a mention hover card, resolved by the caller. */
export interface MentionPreview {
	kind: "image" | "file";
	name: string;
	size?: number;
	dataUrl?: string;
}

export interface ComposerEditorHandle {
	readonly value: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	/** The editor's mounted root (anchor/measurement target). */
	readonly dom: HTMLElement;
	setSelectionRange(start: number, end?: number): void;
	focus(options?: { preventScroll?: boolean }): void;
	blur(): void;
	/** Replace the current selection and leave the caret after the insertion. */
	insertText(text: string): void;
	replaceRange(from: number, to: number, text: string): void;
	/** Re-measure after a value or layout change (CodeMirror owns heights). */
	autosize(): void;
	setFocused(focused: boolean): void;
}

export function isComposerEditorHandle(value: unknown): value is ComposerEditorHandle {
	return typeof value === "object" && value !== null && "insertText" in value && "autosize" in value;
}
