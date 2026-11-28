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

/** Marks a document write made by dictation. Declared before the field that
 *  reads it: `dictationField` keeps its range only across these writes. */
export const dictationWrite = Annotation.define<true>();
/** Range the dictation owns right now (committed + provisional). */
export const setDictationRange = StateEffect.define<{ from: number; to: number } | null>();

/** Decorates the dictated range: it is real document text (so the composer,
 *  the send path and the draft store all see it), painted muted to read as
 *  still-provisional. Marking a RANGE rather than inserting a widget is what
 *  lets the entrance effect animate only the characters that newly arrived —
 *  a widget rebuilt on every decode replayed the whole phrase.
 *
 *  The range is dropped on any edit that is not the dictation's own write, so
 *  typing inside it turns those words into ordinary draft text. */
export const dictationField = StateField.define<{ from: number; to: number } | null>({
	create: () => null,
	update(range, transaction) {
		let next = range;
		for (const effect of transaction.effects) {
			if (effect.is(setDictationRange)) next = effect.value;
		}
		if (transaction.docChanged && next) {
			// Map the range across our own insertions so a growing phrase keeps
			// its decoration; a user edit clears it (their words are not a guess).
			const ours = transaction.annotation(dictationWrite) === true;
			if (ours) {
				const from = transaction.changes.mapPos(next.from, -1);
				const to = transaction.changes.mapPos(next.to, 1);
				next = { from, to };
			} else {
				next = null;
			}
		}
		return next;
	},
	provide: field =>
		EditorView.decorations.from(field, range => {
			if (!range || range.to <= range.from) return Decoration.none;
			return Decoration.set([
				Decoration.mark({ class: "musepi-composer-editor__preview" }).range(range.from, range.to),
			]);
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
