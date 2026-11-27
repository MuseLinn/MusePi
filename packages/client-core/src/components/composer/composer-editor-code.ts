import {
	Annotation,
	type EditorState,
	type Extension,
	Prec,
	type Range,
	StateEffect,
	StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { advanceTail, EMPTY_TAIL, type TailEffect, type TailState } from "@musepi/client-markdown";
import type { ComposerSelection, EditorMark } from "./composer-editor-types";

/**
 * One reference rendered as an icon+label chip in place of its raw text.
 *
 * The document keeps the literal token (a path, a `history://` URL) because
 * the send path and the parsers read it; only the PAINT is replaced. The
 * widget is inline-block so it sits on the text baseline instead of opening
 * a line box of its own — that is what keeps a chip from drifting off the
 * line the way a fixed-height flex pill did.
 */
class ReferenceChipWidget extends WidgetType {
	constructor(
		readonly label: string,
		readonly kind: "file" | "folder" | "session",
		readonly className: string,
	) {
		super();
	}

	override eq(other: ReferenceChipWidget): boolean {
		return other.label === this.label && other.kind === this.kind && other.className === this.className;
	}

	override toDOM(): HTMLElement {
		const chip = document.createElement("span");
		// `className` already carries the reference class from the caller; only
		// the kind variant is added here, so the two spellings cannot drift.
		chip.className = `${this.className} gui-ta-ref--${this.kind}`;
		chip.textContent = this.label;
		// The chip stands in for text the user can still edit around; letting it
		// swallow pointer events would make the range feel like an object.
		chip.setAttribute("aria-hidden", "true");
		return chip;
	}

	override ignoreEvent(): boolean {
		return false;
	}
}

/** Read the dictation effect preset the transcript uses, so the preview speaks
 *  the same visual language as a streaming reply. Kept in one place: the
 *  transcript reads the same key, and a second reading here must not invent its
 *  own default. */
export function dictationTailEffect(): TailEffect {
	const fallback: TailEffect = "typewriter";
	if (typeof localStorage === "undefined") return fallback;
	try {
		const value = localStorage.getItem("musepi-gui-chat-effect");
		return value === "burst" || value === "shimmer" || value === "glitch" || value === "flip" || value === "ink"
			? value
			: fallback;
	} catch {
		return fallback;
	}
}

/** The volatile speech-to-text preview: the words the recognizer currently
 *  believes, shown at the caret but NOT part of the document.
 *
 *  It must stay outside `value`: a preview is a guess that gets replaced on
 *  every decode, so writing it into the document would leak a half sentence
 *  into the send path, the draft store and the undo history. The widget paints
 *  it as a trailing ghost instead and `ignoreEvent()`s everything, so it never
 *  takes the caret away from the real text.
 *
 *  Growth is painted through the transcript's own tail effect (`advanceTail`),
 *  so each newly recognized character enters with the same animation a
 *  streaming reply uses. The element is STABLE across updates (CodeMirror only
 *  destroys it when the widget leaves the range), which is what lets the effect
 *  animate the delta instead of replaying the whole phrase each decode.
 */
class PreviewTailWidget extends WidgetType {
	constructor(readonly text: string) {
		super();
	}

	override eq(other: PreviewTailWidget): boolean {
		return other.text === this.text;
	}

	override toDOM(): HTMLElement {
		const tail = document.createElement("span");
		tail.className = "musepi-composer-editor__preview";
		tail.setAttribute("aria-hidden", "true");
		this.paint(tail);
		return tail;
	}

	override updateDOM(dom: HTMLElement): boolean {
		this.paint(dom);
		return true;
	}

	override ignoreEvent(): boolean {
		return true;
	}

	private paint(dom: HTMLElement): void {
		const effect = dictationTailEffect();
		dom.dataset.effect = effect;
		dom.classList.toggle("musepi-composer-editor__preview--shimmer", effect === "shimmer");
		// CodeMirror reuses the existing element (`updateDOM`) even when the widget
		// instance is new, and a new instance starts at EMPTY_TAIL while the DOM
		// still holds the previous phrase. Adopt what the element actually
		// contains: `advanceTail` then sees the replacement is not a prefix of it
		// and clears before painting. Resetting to EMPTY_TAIL instead would look
		// like "everything is new" and append onto the stale text.
		const painted = dom.textContent ?? "";
		if (painted !== this.tail.appended) this.tail = { appended: painted };
		this.tail = advanceTail(dom, this.text, effect, this.tail);
	}

	/** What this element has been advanced to; re-derived from the DOM in paint. */
	private tail: TailState = EMPTY_TAIL;
}

/** The preview string the widget paints; a change repaints in place. */
export const setPreview = StateEffect.define<string>();
/** Preview text painted at the caret (empty = nothing painted). */
export const previewField = StateField.define<{ text: string; pos: number }>({
	create: () => ({ text: "", pos: 0 }),
	update(value, transaction) {
		// A document edit makes the previous guess meaningless: committing a
		// segment or typing over it both invalidate the in-flight preview.
		if (transaction.docChanged) return { text: "", pos: 0 };
		for (const effect of transaction.effects) {
			if (effect.is(setPreview)) {
				return { text: effect.value, pos: transaction.state.selection.main.head };
			}
		}
		// Follow the caret: dictation lands where the user is, so a ghost left at
		// an older offset would look like it belongs to a different sentence.
		if (transaction.selection !== undefined) {
			return { text: value.text, pos: transaction.state.selection.main.head };
		}
		return value;
	},
	provide: field =>
		EditorView.decorations.from(field, ({ text, pos }) => {
			if (text.length === 0) return Decoration.none;
			return Decoration.set([Decoration.widget({ widget: new PreviewTailWidget(text), side: 1 }).range(pos)]);
		}),
});

/** Marks the transaction that writes a changed `value` prop into the editor. */
export const valuePropWrite = Annotation.define<true>();
/** Repaint mention decorations when the staged chip list changes. */
export const refreshMarks = StateEffect.define<null>();

/** EditorMarks -> CodeMirror mark decorations, rebuilt on doc/context change. */
export function marksField(marksRef: { current: readonly EditorMark[] }): Extension {
	const build = (): DecorationSet => {
		const ranges: Range<Decoration>[] = [];
		for (const mark of marksRef.current) {
			if (mark.revealAs !== undefined) {
				// A reference reads as a chip, not as its raw token. Replace the
				// whole range (never mark it) so the literal path/URL is not also
				// painted underneath the widget.
				ranges.push(
					Decoration.replace({
						widget: new ReferenceChipWidget(mark.revealAs.label, mark.revealAs.kind, mark.className),
					}).range(mark.from, mark.to),
				);
				continue;
			}
			if (mark.mentionName !== undefined && mark.to - mark.from > 1) {
				// The `@` is syntax, not content: the pill shows an icon + `图片1`.
				// Replace the sigil with nothing while the document keeps it — the
				// send path and the ordinal parser still need `@图片N`.
				ranges.push(Decoration.replace({}).range(mark.from, mark.from + 1));
				ranges.push(Decoration.mark({ class: mark.className }).range(mark.from + 1, mark.to));
				continue;
			}
			ranges.push(Decoration.mark({ class: mark.className }).range(mark.from, mark.to));
		}
		return Decoration.set(ranges, true);
	};
	return StateField.define<DecorationSet>({
		create: build,
		update(decorations, transaction) {
			if (transaction.docChanged || transaction.effects.some(effect => effect.is(refreshMarks))) {
				return build();
			}
			return decorations;
		},
		provide: field => EditorView.decorations.from(field),
	});
}

/**
 * Reference chips are atomic: the caret steps over them instead of walking
 * through the raw token the widget hides. Without this the hidden path is
 * still editable one character at a time, which reads as the chip randomly
 * breaking when someone presses ← near it.
 */
export function referenceAtomicRanges(marksRef: { current: readonly EditorMark[] }): Extension {
	return EditorView.atomicRanges.of(view => {
		const ranges: Range<Decoration>[] = [];
		for (const mark of marksRef.current) {
			if (mark.revealAs === undefined) continue;
			const widget = new ReferenceChipWidget(mark.revealAs.label, mark.revealAs.kind, mark.className);
			ranges.push(Decoration.replace({ widget }).range(mark.from, mark.to));
		}
		return Decoration.set(ranges, true);
	});
}

/** `Prec.highest` keymap so the composer's policy layer wins over defaults. */
export function interceptKeymap(onKeyDown: (event: KeyboardEvent) => boolean | void): Extension {
	return Prec.highest(
		keymap.of([
			{
				any: (_view: EditorView, event: KeyboardEvent): boolean => {
					const handled = onKeyDown(event);
					return handled === true || event.defaultPrevented;
				},
			},
		]),
	);
}

export function selectionOf(state: EditorState): ComposerSelection {
	return { start: state.selection.main.from, end: state.selection.main.to };
}

/** Map a document offset across an external whole-document replacement by its
 *  unchanged prefix/suffix; an offset inside the changed middle clamps to the
 *  change start. An empty old document maps to the end (a restored prompt
 *  should put the caret after its text). */
export function mapPosition(oldText: string, nextText: string, position: number): number {
	if (oldText.length === 0) return nextText.length;
	let prefix = 0;
	while (prefix < oldText.length && prefix < nextText.length && oldText[prefix] === nextText[prefix]) {
		prefix++;
	}
	let oldEnd = oldText.length;
	let nextEnd = nextText.length;
	while (oldEnd > prefix && nextEnd > prefix && oldText[oldEnd - 1] === nextText[nextEnd - 1]) {
		oldEnd--;
		nextEnd--;
	}
	if (position <= prefix) return position;
	if (position >= oldEnd) return nextEnd + (position - oldEnd);
	return prefix;
}
