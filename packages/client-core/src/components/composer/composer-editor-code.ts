import {
	Annotation,
	type EditorState,
	type Extension,
	Prec,
	type Range,
	StateEffect,
	StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import type { ComposerSelection, EditorMark } from "./composer-editor-types";

/** Marks the transaction that writes a changed `value` prop into the editor. */
export const valuePropWrite = Annotation.define<true>();
/** Repaint mention decorations when the staged chip list changes. */
export const refreshMarks = StateEffect.define<null>();

/** EditorMarks -> CodeMirror mark decorations, rebuilt on doc/context change. */
export function marksField(marksRef: { current: readonly EditorMark[] }): Extension {
	const build = (): DecorationSet => {
		const ranges: Range<Decoration>[] = [];
		for (const mark of marksRef.current) {
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
