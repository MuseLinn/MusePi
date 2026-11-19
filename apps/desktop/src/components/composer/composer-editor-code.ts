import { Annotation, type EditorState, type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import type { ComposerSelection } from "./composer-editor-types";
import { type HighlightKind, HL_CLASS, type MentionPreview, parseHighlightSpans } from "./token-spans";

/** Marks the transaction that writes a changed `value` prop into the editor. */
export const valuePropWrite = Annotation.define<true>();
/** Repaint mention decorations when the staged chip list changes. */
export const refreshTokens = StateEffect.define<null>();

const TOKEN_MARK: Record<HighlightKind, Decoration> = {
	slash: Decoration.mark({ class: HL_CLASS.slash }),
	bang: Decoration.mark({ class: HL_CLASS.bang }),
	magic: Decoration.mark({ class: HL_CLASS.magic }),
	mention: Decoration.mark({ class: HL_CLASS.mention }),
};

/** Token spans -> CodeMirror mark decorations, rebuilt on doc/context change. */
export function tokenField(
	resolverRef: { current: ((name: string) => MentionPreview | null) | undefined },
	spansRef: { current: ReturnType<typeof parseHighlightSpans> },
): Extension {
	const build = (state: EditorState): DecorationSet => {
		const spans = parseHighlightSpans(state.doc.toString(), name => resolverRef.current?.(name) ?? null);
		spansRef.current = spans;
		return Decoration.set(
			spans.map(span => TOKEN_MARK[span.kind].range(span.start, span.end)),
			true,
		);
	};
	return StateField.define<DecorationSet>({
		create: build,
		update(decorations, transaction) {
			if (transaction.docChanged || transaction.effects.some(effect => effect.is(refreshTokens))) {
				return build(transaction.state);
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
