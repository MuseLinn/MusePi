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
 *  paints `className` and reads `mentionName` for the hover card.
 *
 * `revealAs` turns a token that would otherwise read as raw text (a file
 * path, a `history://` reference) into an icon+label chip. The DOCUMENT keeps
 * the literal text — the send path and the parsers need it — while the
 * editor renders the chip in its place, so nothing downstream has to know
 * the composer decided to look nicer.
 */
export interface EditorMark {
	from: number;
	to: number;
	className: string;
	mentionName?: string;
	/** Label shown in place of the raw range; absent = paint the text itself. */
	revealAs?: {
		label: string;
		/** Icon family: a file, a folder, or a session. */
		kind: "file" | "folder" | "session";
	};
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
	/** Show the volatile speech preview at the caret. It is painted, never
	 *  inserted: `value` stays exactly what the send path would send.
	 *
	 *  Only for hosts that have no way to write the draft themselves. Dictation
	 *  uses {@link writeDictation} instead: a preview painted at the caret next
	 *  to committed text written somewhere else is exactly the two-places bug
	 *  that scattered words mid-sentence. */
	setPreview(text: string): void;
	/** Replace the dictated region with one composed string and put the caret
	 *  after it.
	 *
	 *  `committed` is the finalized text this dictation owns and `hypothesis`
	 *  the run still being recognized; they are written as one block, so a
	 *  phrase can never land anywhere but after the previous one. `restart`
	 *  freezes the current document and caret as the region's origin — pass it
	 *  on the first write of a dictation (and after the user edited elsewhere),
	 *  and false for every later repaint so the origin cannot drift.
	 */
	writeDictation(committed: string, hypothesis: string, restart: boolean): void;
	/** Discard everything this dictation wrote and restore the frozen document.
	 *  Dictation writes into the draft now, so cancelling must take its words
	 *  back out — an Esc that left a half sentence behind is worse than no
	 *  preview at all. */
	cancelDictation(): void;
	setFocused(focused: boolean): void;
}

export function isComposerEditorHandle(value: unknown): value is ComposerEditorHandle {
	return typeof value === "object" && value !== null && "insertText" in value && "autosize" in value;
}
