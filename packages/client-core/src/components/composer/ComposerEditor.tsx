import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import {
	interceptKeymap,
	mapPosition,
	marksField,
	previewField,
	referenceAtomicRanges,
	refreshMarks,
	selectionOf,
	setPreview as setPreviewEffect,
	valuePropWrite,
} from "./composer-editor-code";
import { ComposerMentionPop, type MentionPop } from "./composer-editor-pop";
import type { ComposerEditorHandle, ComposerSelection, EditorMark, MentionPreview } from "./composer-editor-types";

/**
 * CodeMirror 6 composer editor (openchamber parity).
 *
 * The document stays a plain string — `value` is exactly what the send path
 * sees — while CodeMirror owns the text and the caret together. That removes
 * the transparent-textarea/mirror arrangement and its metric ceiling: token
 * decorations, selection, wrapping and IME all live in one layer.
 *
 * The imperative handle mirrors the textarea members the composers already
 * call, so completion, voice, paste and draft paths keep their code.
 */

export interface ComposerEditorProps {
	value: string;
	onChange(value: string, selection: ComposerSelection): void;
	onKeyDown?(event: KeyboardEvent): boolean | void;
	onPaste?(event: ClipboardEvent): void;
	onDragOver?(event: DragEvent): void;
	onDragLeave?(): void;
	onDrop?(event: DragEvent): void;
	onFocus?(): void;
	onBlur?(): void;
	onCompositionStart?(): void;
	onCompositionEnd?(): void;
	placeholder?: string;
	spellCheck?: boolean;
	autoComplete?: string;
	/** Painted token ranges, recomputed by the caller on every text/context change. */
	marks?: readonly EditorMark[];
	/** Resolve a mention name for the hover card; null = no preview. */
	resolveMention?(name: string): MentionPreview | null;
	onMentionClick?(start: number): void;
	className?: string;
	dataComposerInput?: boolean;
	dataFocused?: boolean;
	variant?: "session" | "welcome" | "compact";
	ariaLabel?: string;
	autoFocus?: boolean;
	/** Editable is a live prop: the mobile composer disables it while a host
	 *  session is unavailable. */
	editable?: boolean;
	morphId?: string;
}

const editableCompartment = new Compartment();

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
	function ComposerEditor(props, ref) {
		const {
			value,
			onChange,
			onKeyDown,
			onPaste,
			onDragOver,
			onDragLeave,
			onDrop,
			onFocus,
			onBlur,
			onCompositionStart,
			onCompositionEnd,
			placeholder,
			spellCheck = false,
			autoComplete = "off",
			resolveMention,
			marks = [],
			onMentionClick,
			className,
			dataComposerInput = false,
			dataFocused = false,
			variant = "session",
			ariaLabel,
			autoFocus = false,
			editable = true,
			morphId,
		} = props;
		const hostRef = useRef<HTMLDivElement | null>(null);
		const viewRef = useRef<EditorView | null>(null);
		const valueRef = useRef(value);
		valueRef.current = value;
		// Handlers reach the long-lived view through refs: a parent render must
		// not rebuild the editor and drop focus/selection mid-typing.
		const handlersRef = useRef({
			onChange,
			onKeyDown,
			onPaste,
			onDragOver,
			onDragLeave,
			onDrop,
			onFocus,
			onBlur,
			onCompositionStart,
			onCompositionEnd,
			onMentionClick,
		});
		handlersRef.current = {
			onChange,
			onKeyDown,
			onPaste,
			onDragOver,
			onDragLeave,
			onDrop,
			onFocus,
			onBlur,
			onCompositionStart,
			onCompositionEnd,
			onMentionClick,
		};
		const resolverRef = useRef(resolveMention);
		resolverRef.current = resolveMention;
		const marksRef = useRef<readonly EditorMark[]>(marks);
		marksRef.current = marks;
		/** True while CodeMirror is dispatching an update and our onChange runs:
		 *  a synchronous parent render/effect must not dispatch again. */
		const inUpdateRef = useRef(false);
		const [pop, setPop] = useState<MentionPop | null>(null);
		/** Whether the dictation preview is currently painted. A preview occupies
		 *  the caret, so the placeholder must yield to it — the document is still
		 *  empty, and drawing both puts two sentences in the same box. */
		const [previewing, setPreviewing] = useState(false);

		useLayoutEffect(() => {
			const host = hostRef.current;
			if (!host) return;
			const view = new EditorView({
				state: EditorState.create({
					doc: valueRef.current,
					extensions: [
						history(),
						editableCompartment.of(EditorView.editable.of(editable)),
						EditorView.lineWrapping,
						// Composer keys win over CodeMirror defaults (Enter sends,
						// ArrowUp walks history, Backspace removes a mention atom).
						interceptKeymap(event => handlersRef.current.onKeyDown?.(event) ?? false),
						keymap.of([...standardKeymap, ...historyKeymap]),
						marksField(marksRef),
						previewField,
						referenceAtomicRanges(marksRef),
						EditorView.updateListener.of(update => {
							const handlers = handlersRef.current;
							if (update.docChanged) {
								const programmatic = update.transactions.every(
									transaction => !transaction.docChanged || transaction.annotation(valuePropWrite) === true,
								);
								setPop(null);
								// A document edit retires the preview (previewField clears it),
								// so the placeholder must be eligible again — otherwise typing
								// over a cancelled preview leaves an empty box with no hint.
								setPreviewing(false);
								if (!programmatic) {
									inUpdateRef.current = true;
									try {
										handlers.onChange(update.state.doc.toString(), selectionOf(update.state));
									} finally {
										inUpdateRef.current = false;
									}
								}
							}
						}),
						EditorView.contentAttributes.of({
							spellcheck: String(spellCheck),
							autocomplete: autoComplete,
							autocapitalize: "off",
							...(ariaLabel ? { "aria-label": ariaLabel } : {}),
						}),
						EditorView.domEventHandlers({
							paste: (event: ClipboardEvent) => {
								handlersRef.current.onPaste?.(event);
								return false;
							},
							dragover: (event: DragEvent) => {
								handlersRef.current.onDragOver?.(event);
								return false;
							},
							dragleave: (event: DragEvent, editor: EditorView) => {
								const related = event.relatedTarget as Node | null;
								if (related && editor.contentDOM.contains(related)) return false;
								handlersRef.current.onDragLeave?.();
								return false;
							},
							drop: (event: DragEvent) => {
								handlersRef.current.onDrop?.(event);
								return false;
							},
							focus: () => {
								handlersRef.current.onFocus?.();
								return false;
							},
							blur: () => {
								handlersRef.current.onBlur?.();
								return false;
							},
							compositionstart: () => {
								handlersRef.current.onCompositionStart?.();
								return false;
							},
							compositionend: () => {
								handlersRef.current.onCompositionEnd?.();
								return false;
							},
							mousemove: (event: MouseEvent, editor: EditorView) => {
								const at = mentionAt(editor, event);
								if (!at) {
									setPop(current => (current === null ? current : null));
									return false;
								}
								const preview = resolverRef.current?.(at.name);
								if (!preview) {
									setPop(current => (current === null ? current : null));
									return false;
								}
								const coords = editor.coordsAtPos(at.mark.from);
								if (!coords) return false;
								setPop(current => {
									if (
										current?.name === at.name &&
										Math.abs(current.x - coords.left) < 2 &&
										Math.abs(current.y - coords.top) < 2
									) {
										return current;
									}
									return { name: at.name, preview, x: coords.left, y: coords.top };
								});
								return false;
							},
							mouseleave: () => {
								setPop(null);
								return false;
							},
							click: (event: MouseEvent, editor: EditorView) => {
								const at = mentionAt(editor, event);
								if (!at) return false;
								handlersRef.current.onMentionClick?.(at.mark.from);
								return true;
							},
						}),
					],
				}),
				parent: host,
			});
			viewRef.current = view;
			view.requestMeasure();
			if (autoFocus) view.focus();
			return () => {
				viewRef.current = null;
				setPop(null);
				view.destroy();
			};
			// Built once: handlers and the resolver are read through refs.
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		useEffect(() => {
			viewRef.current?.dispatch({
				effects: editableCompartment.reconfigure(EditorView.editable.of(editable)),
			});
		}, [editable]);

		// External value writes (completion, undo backfill, voice, enhance):
		// replace the document, keep the caret at the end like a controlled
		// textarea, and mark the transaction so onChange does not echo it back.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			const current = view.state.doc.toString();
			if (current === value) return;
			const apply = (): void => {
				if (inUpdateRef.current) {
					queueMicrotask(apply);
					return;
				}
				const live = viewRef.current;
				if (!live) return;
				const latest = valueRef.current;
				const doc = live.state.doc.toString();
				if (doc === latest) return;
				const selection = live.state.selection.main;
				// Keep the caret near the same text: attachment renumbering and
				// token retargeting rewrite in place, and jumping to the end would
				// throw the user out of the sentence they were editing.
				const anchor = mapPosition(doc, latest, selection.anchor);
				const head = mapPosition(doc, latest, selection.head);
				live.dispatch({
					changes: { from: 0, to: doc.length, insert: latest },
					selection: { anchor, head },
					annotations: valuePropWrite.of(true),
				});
				live.requestMeasure();
			};
			try {
				apply();
			} catch {
				// An onChange handler can synchronously render the parent (tests and
				// flushSync paths), and CodeMirror forbids a dispatch while its own
				// update is still in progress. Retry on the next microtask, before
				// the caller's requestAnimationFrame caret restore.
				queueMicrotask(apply);
			}
		}, [value]);

		// Attachment inventory changed without a document edit: repaint the
		// mention decorations against the new chip list.
		useEffect(() => {
			// Defer if a parent render lands inside CodeMirror's own update dispatch.
			const refresh = (): void => {
				if (inUpdateRef.current) {
					queueMicrotask(refresh);
					return;
				}
				viewRef.current?.dispatch({ effects: refreshMarks.of(null) });
			};
			refresh();
		}, [marks]);

		function mentionAt(editor: EditorView, event: MouseEvent): { mark: EditorMark; name: string } | null {
			const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos === null) return null;
			for (const mark of marksRef.current) {
				if (!mark.mentionName || pos < mark.from || pos > mark.to) continue;
				return { mark, name: mark.mentionName };
			}
			return null;
		}

		useImperativeHandle(
			ref,
			(): ComposerEditorHandle => ({
				get value() {
					return viewRef.current?.state.doc.toString() ?? valueRef.current;
				},
				get selectionStart() {
					return viewRef.current?.state.selection.main.from ?? 0;
				},
				get selectionEnd() {
					return viewRef.current?.state.selection.main.to ?? 0;
				},
				get dom() {
					return hostRef.current ?? viewRef.current?.dom ?? document.body;
				},
				setSelectionRange(start, end = start) {
					const view = viewRef.current;
					if (!view) return;
					view.dispatch({ selection: { anchor: start, head: end } });
				},
				focus() {
					viewRef.current?.focus();
				},
				blur() {
					viewRef.current?.contentDOM.blur();
				},
				insertText(text) {
					const view = viewRef.current;
					if (!view) return;
					view.dispatch(view.state.replaceSelection(text));
				},
				replaceRange(from, to, text) {
					const view = viewRef.current;
					if (!view) return;
					view.dispatch({
						changes: { from, to, insert: text },
						selection: { anchor: from + text.length },
					});
				},
				setPreview(text) {
					const view = viewRef.current;
					if (!view) return;
					if (view.state.field(previewField).text === text) return;
					view.dispatch({ effects: setPreviewEffect.of(text) });
					view.requestMeasure();
					setPreviewing(text.length > 0);
				},
				autosize() {
					const view = viewRef.current;
					const host = hostRef.current;
					if (!view || !host) return;
					const style = getComputedStyle(view.contentDOM);
					const lineHeight = Number.parseFloat(style.lineHeight) || 20;
					const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
					const rows = variant === "welcome" ? 3 : variant === "compact" ? 1 : 2;
					host.style.minHeight = `${rows * lineHeight + padding}px`;
					const bound = host.closest<HTMLElement>(".gui-chat-body");
					const lineCap = 8 * lineHeight + padding;
					const cap = bound
						? Math.min(
								lineCap,
								Math.max(
									rows * lineHeight + padding,
									bound.clientHeight -
										(bound.querySelector<HTMLElement>(".gui-transcript")?.offsetHeight ?? 0) -
										96,
								),
							)
						: lineCap;
					host.style.maxHeight = host.getAttribute("data-focused") === "1" ? "none" : `${cap}px`;
					view.requestMeasure();
				},
				setFocused(focused) {
					hostRef.current?.setAttribute("data-focused", focused ? "1" : "0");
				},
			}),
			// The handle reads live refs; it never needs rebuilding.
			// eslint-disable-next-line react-hooks/exhaustive-deps
			[],
		);

		return (
			<div
				ref={hostRef}
				className={`musepi-composer-editor musepi-composer-editor--${variant}${className ? ` ${className}` : ""}`}
				data-focused={dataFocused ? "1" : "0"}
				data-editable={editable ? "1" : "0"}
				{...(morphId ? { "data-morph-id": morphId } : {})}
				{...(dataComposerInput ? { "data-composer-input": "" } : {})}
			>
				{value.length === 0 && !previewing && placeholder ? (
					<span className="musepi-composer-editor__placeholder" aria-hidden>
						{placeholder}
					</span>
				) : null}
				{pop ? <ComposerMentionPop pop={pop} /> : null}
			</div>
		);
	},
);
