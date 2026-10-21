/**
 * The composer's editor, backed by CodeMirror 6.
 *
 * Why a real editor rather than a textarea with a highlight overlay painted on
 * top: the overlay can only paint styles that do not change the glyph advance
 * width — colour, background, underline — because any metric change makes the
 * painted copy drift out from under the caret. That rules out bold, rules out
 * italic, and on a wrapped line it rules out the whole overlay. CodeMirror owns
 * the text and the caret together, so there is no second layer to keep aligned.
 *
 * The document stays a plain string. `getValue()` is exactly what gets sent, so
 * nothing downstream has to serialize a rich document model back into a prompt
 * — the editor is a rendering of a string, not a new data model.
 *
 * The component is a CONTROLLED primitive: it renders `value`, reports edits,
 * and exposes an imperative handle for the caret-level operations the composer
 * performs (insert a mention, restore a draft, replace a token, place a popup
 * at the caret). Every policy decision — what a key means, which picker opens,
 * when to send — stays with the caller.
 *
 * Adapted from openchamber's `composer/editor/ComposerEditor.tsx`.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	placeholder as placeholderExtension,
	type ViewUpdate,
} from "@codemirror/view";
import { type ReactNode, useEffect, useImperativeHandle, useRef } from "react";

/** The caret or selection, in document offsets. */
export interface ComposerSelection {
	readonly start: number;
	readonly end: number;
}

/** One edit, as CodeMirror reports it. */
export interface ComposerChange {
	readonly value: string;
	readonly selection: ComposerSelection;
	/** True when the edit came from a paste rather than typing. */
	readonly fromPaste: boolean;
	/** The text this edit inserted; empty for a deletion. */
	readonly insertedText: string;
	/**
	 * True when the edit only applied a new `value` prop: text the app put
	 * there (a restored draft, a prepared prompt), not anything the user typed
	 * or pasted. Callers must not open pickers for it.
	 */
	readonly fromValueProp: boolean;
}

/** The imperative surface the composer drives. */
export interface ComposerEditorHandle {
	focus(options?: { preventScroll?: boolean }): void;
	blur(): void;
	isFocused(): boolean;
	getValue(): string;
	getSelection(): ComposerSelection;
	setSelection(start: number, end?: number): void;
	selectAll(): void;
	/** Replace the selection, leaving the caret after the insertion. */
	insertText(text: string): void;
	/** Replace a range; the selection defaults to a caret after the inserted text. */
	replaceRange(from: number, to: number, text: string, selectionStart?: number, selectionEnd?: number): void;
	/** Viewport coordinates of the caret, for positioning popups. */
	caretCoords(position?: number): { top: number; bottom: number; left: number } | null;
	/** The scrollable element, for measuring and scroll compensation. */
	getScrollDOM(): HTMLElement | null;
}

/** A painted region: the composer's own pills (slash, bang, magic, mention). */
export interface EditorMark {
	readonly from: number;
	readonly to: number;
	readonly className: string;
	/** The mention's name, for the hover card. */
	readonly mentionName?: string;
}

export interface ComposerEditorProps {
	value: string;
	onChange(change: ComposerChange): void;
	/** Caret or selection moved without the document changing. */
	onSelectionChange?(selection: ComposerSelection): void;
	/**
	 * Key press before CodeMirror handles it. Return true to consume the
	 * event — this is where the composer routes autocomplete navigation,
	 * message history and send.
	 */
	onKeyDown?(event: KeyboardEvent): boolean;
	onKeyUp?(event: KeyboardEvent): void;
	onFocus?(): void;
	onBlur?(): void;
	onPaste?(event: ClipboardEvent): void;
	placeholder?: string;
	editable?: boolean;
	spellCheck?: boolean;
	/** Fill the available height instead of growing with the content. */
	fillContainer?: boolean;
	/** Lines of text shown before the editor starts scrolling. */
	maxLines?: number;
	/**
	 * Selector of the ancestor the composer must never outgrow. The cap is
	 * measured — the ancestor's height minus the chrome around the editor,
	 * both read from the DOM — and the smaller of it and `maxLines` wins.
	 */
	boundSelector?: string;
	/** Breathing room kept between the grown composer and the bound's edge. */
	boundGapPx?: number;
	className?: string;
	contentClassName?: string;
	/** Value of the host's `data-composer-input` attribute. */
	dataChatInput?: string;
	"aria-label"?: string;
	"data-testid"?: string;
	/** The pills to paint, recomputed by the caller on every value change. */
	marks?: readonly EditorMark[];
}

/**
 * The text a transaction inserted.
 *
 * CodeMirror reports the change set directly, so this needs none of the
 * prefix/suffix diffing a textarea's `onChange` required — and it is exact,
 * which is what lets the composer tell a typed `@` from a pasted one.
 */
function insertedTextOf(transaction: {
	changes: {
		iterChanges(
			fn: (fromA: number, toA: number, fromB: number, toB: number, inserted: { toString(): string }) => void,
		): void;
	};
}): string {
	let inserted = "";
	transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
		inserted += text.toString();
	});
	return inserted;
}

/** Marks the transaction that writes a changed `value` prop into the editor. */
const valuePropWrite = Annotation.define<true>();

/**
 * Compartments are configuration keys, not per-view state, so one set can serve
 * every editor. They live at module scope because a kept-alive view outlives
 * the component that created it: per-instance compartments would be unknown to
 * the reused view's configuration, and reconfiguring it would throw.
 */
const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();

/** Carries a recomputed decoration set into the state. */
const setMarksEffect = StateEffect.define<DecorationSet>();

/**
 * The painted pills, as a state field: the field holds the current decoration
 * set and exposes it through `EditorView.decorations`. That provide-chain is
 * the only way a DecorationSet reaches the view — a DecorationSet is not
 * itself an Extension, so it cannot go into a Compartment.
 */
const marksField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update: (value, transaction) => {
		for (const effect of transaction.effects) {
			if (effect.is(setMarksEffect)) return effect.value;
		}
		return value;
	},
	provide: field => EditorView.decorations.from(field),
});

/** The painted regions, as a decoration set. */
function markDecorations(marks: readonly EditorMark[]): DecorationSet {
	const builder = [];
	for (const mark of marks) {
		if (mark.to <= mark.from) continue;
		builder.push(
			Decoration.mark({
				class: mark.className,
				attributes: mark.mentionName ? { "data-mention": mark.mentionName } : {},
			}).range(mark.from, mark.to),
		);
	}
	return Decoration.set(builder, true);
}

export function ComposerEditor(props: ComposerEditorProps, ref: React.Ref<ComposerEditorHandle>): ReactNode {
	const {
		value,
		onChange,
		onSelectionChange,
		onKeyDown,
		onKeyUp,
		onFocus,
		onBlur,
		onPaste,
		placeholder,
		editable = true,
		spellCheck = false,
		fillContainer = false,
		maxLines,
		boundSelector,
		boundGapPx = 0,
		className,
		contentClassName,
		dataChatInput = "true",
		marks = [],
	} = props;

	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	// The callbacks change every render; the view must not be rebuilt for them.
	const handlersRef = useRef({ onChange, onSelectionChange, onKeyDown, onKeyUp, onFocus, onBlur, onPaste });
	handlersRef.current = { onChange, onSelectionChange, onKeyDown, onKeyUp, onFocus, onBlur, onPaste };
	const marksRef = useRef(marks);
	marksRef.current = marks;

	// ── The view ───────────────────────────────────────────────────────
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const handlers = handlersRef.current;
		let lastSelection = { start: 0, end: 0 };

		const view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value,
				extensions: [
					history(),
					EditorView.lineWrapping,
					editableCompartment.of(EditorState.readOnly.of(!editable)),
					placeholderCompartment.of(placeholder ? placeholderExtension(placeholder) : []),
					marksField,
					EditorView.contentAttributes.of({
						"data-chat-input": dataChatInput,
						...(spellCheck ? {} : { spellcheck: "false" }),
						// Per-line direction: each line takes the direction of its
						// first strong character, while the content root stays LTR
						// — dir=auto there would change the content's direction as
						// the document is replaced.
						dir: "ltr",
					}),
					EditorView.theme({
						"&": { height: fillContainer ? "100%" : "auto" },
						".cm-content": { textAlign: "start" },
					}),
					EditorView.updateListener.of((update: ViewUpdate) => {
						if (!update.docChanged) {
							if (update.selectionSet) {
								const sel = update.state.selection.main;
								lastSelection = { start: sel.from, end: sel.to };
								handlers.onSelectionChange?.(lastSelection);
							}
							return;
						}
						const change = update.state.selection.main;
						const fromValueProp = update.transactions.some(t => t.annotation(valuePropWrite));
						const fromPaste = update.transactions.some(t => t.isUserEvent("input.paste"));
						handlers.onChange({
							value: update.state.doc.toString(),
							selection: { start: change.from, end: change.to },
							fromPaste,
							insertedText: insertedTextOf(update.transactions[0]!),
							fromValueProp,
						});
					}),
					EditorView.domEventHandlers({
						keydown: (event, _view) => {
							// The composer's policy layer sees the key FIRST: it
							// routes autocomplete navigation, message history and
							// send, and returns true to consume it.
							if (handlers.onKeyDown?.(event)) {
								event.preventDefault();
								return true;
							}
							return false;
						},
						keyup: event => {
							handlers.onKeyUp?.(event);
						},
						focus: () => {
							handlers.onFocus?.();
						},
						blur: () => {
							handlers.onBlur?.();
						},
						paste: (event, _view) => {
							handlers.onPaste?.(event);
							return false;
						},
					}),
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
				],
			}),
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// The view is created once; every prop that can change is applied by
		// the effects below, so a rebuild never loses the caret.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── The value prop ─────────────────────────────────────────────────
	// A changed `value` is text the APP put there (a restored draft, a
	// prepared prompt). It is written with an annotation so the change handler
	// can tell it from a user edit — otherwise a restored draft would open the
	// mention picker.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === value) return;
		view.dispatch({
			changes: { from: 0, to: current.length, insert: value },
			annotations: valuePropWrite.of(true),
			// Keep the caret sane: at the end of the new text unless the
			// selection was already inside it.
			selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
		});
	}, [value]);

	// ── Configuration ─────────────────────────────────────────────────
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: editableCompartment.reconfigure(EditorState.readOnly.of(!editable)),
		});
	}, [editable]);
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: placeholderCompartment.reconfigure(placeholder ? placeholderExtension(placeholder) : []),
		});
	}, [placeholder]);

	// ── The painted pills ──────────────────────────────────────────────
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: setMarksEffect.of(markDecorations(marks)),
		});
	}, [marks]);

	// ── The imperative surface ─────────────────────────────────────────
	useImperativeHandle(
		ref,
		(): ComposerEditorHandle => ({
			focus: options => {
				viewRef.current?.focus();
				if (options?.preventScroll) {
					viewRef.current?.dispatch({
						effects: EditorView.scrollIntoView(viewRef.current.state.selection.main.from, { y: "nearest" }),
					});
				}
			},
			blur: () => viewRef.current?.contentDOM.blur(),
			isFocused: () => viewRef.current?.hasFocus ?? false,
			getValue: () => viewRef.current?.state.doc.toString() ?? "",
			getSelection: () => {
				const sel = viewRef.current?.state.selection.main;
				return sel ? { start: sel.from, end: sel.to } : { start: 0, end: 0 };
			},
			setSelection: (start, end) => {
				const view = viewRef.current;
				if (!view) return;
				view.dispatch({ selection: { anchor: start, head: end ?? start } });
			},
			selectAll: () => {
				const view = viewRef.current;
				if (!view) return;
				view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
			},
			insertText: text => {
				const view = viewRef.current;
				if (!view) return;
				const sel = view.state.selection.main;
				view.dispatch({
					changes: { from: sel.from, to: sel.to, insert: text },
					selection: { anchor: sel.from + text.length },
					userEvent: "input.type",
				});
				view.focus();
			},
			replaceRange: (from, to, text, selectionStart, selectionEnd) => {
				const view = viewRef.current;
				if (!view) return;
				view.dispatch({
					changes: { from, to, insert: text },
					selection: {
						anchor: selectionStart ?? from + text.length,
						head: selectionEnd ?? from + text.length,
					},
					userEvent: "input.type",
				});
			},
			caretCoords: position => {
				const view = viewRef.current;
				if (!view) return null;
				const pos = position ?? view.state.selection.main.from;
				const coords = view.coordsAtPos(pos);
				if (!coords) return null;
				return { top: coords.top, bottom: coords.bottom, left: coords.left };
			},
			getScrollDOM: () => viewRef.current?.scrollDOM ?? null,
		}),
		[],
	);

	return (
		<div
			ref={hostRef}
			className={className}
			data-chat-input={dataChatInput}
			aria-label={props["aria-label"]}
			data-testid={props["data-testid"]}
		/>
	);
}
