import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import {
	dictationField,
	dictationWrite as dictationWriteAnnotation,
	interceptKeymap,
	mapPosition,
	marksField,
	referenceAtomicRanges,
	refreshMarks,
	selectionOf,
	setDictationRange as setDictationRangeEffect,
	valuePropWrite,
} from "./composer-editor-code";
import { ComposerMentionPop, type MentionPop } from "./composer-editor-pop";
import type { ComposerEditorHandle, ComposerSelection, EditorMark, MentionPreview } from "./composer-editor-types";
import { dictationSplice } from "./dictation-splice";

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

/** The dictation range currently decorated, if any. */
function dictationFieldRange(view: EditorView): { from: number; to: number } | null {
	return view.state.field(dictationField, false) ?? null;
}

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
		/** Whether the editor's document is empty, tracked from the VIEW so a
		 *  dictation write retires the hint before the parent's `value` catches
		 *  up. */
		const [docEmpty, setDocEmpty] = useState(value.length === 0);
		/** Whether the dictation preview is currently painted. A preview occupies
		 *  the caret, so the placeholder must yield to it — the document is still
		 *  empty, and drawing both puts two sentences in the same box. */
		/** The document and caret frozen when this dictation started. Cleared by
		 *  the same events that end it (a new start, or a non-dictation edit). */
		const dictationRef = useRef<{ origin: string; start: number; end: number } | null>(null);

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
						dictationField,
						referenceAtomicRanges(marksRef),
						EditorView.updateListener.of(update => {
							const handlers = handlersRef.current;
							if (update.docChanged) {
								const programmatic = update.transactions.every(
									transaction => !transaction.docChanged || transaction.annotation(valuePropWrite) === true,
								);
								setPop(null);
								setDocEmpty(update.state.doc.length === 0);
								// A user edit elsewhere invalidates the frozen region: the next
								// dictation write must re-freeze from where things are NOW, or it
								// would overwrite what they just typed. Our own writes carry the
								// annotation and keep the anchor.
								const ours = update.transactions.some(
									transaction => transaction.annotation(dictationWriteAnnotation) === true,
								);
								if (!ours) {
									dictationRef.current = null;
								}
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
					// Offsets arrive from callers that computed them elsewhere (a
					// measured token, a restored caret); clamp instead of asking
					// CodeMirror for a position the document no longer has.
					const max = view.state.doc.length;
					view.dispatch({
						selection: { anchor: Math.max(0, Math.min(start, max)), head: Math.max(0, Math.min(end, max)) },
					});
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
					// A stale range here throws "Invalid change range" and takes the
					// window down with it, so clamp to the live document.
					const max = view.state.doc.length;
					const start = Math.max(0, Math.min(from, max));
					const end = Math.max(start, Math.min(to, max));
					view.dispatch({
						changes: { from: start, to: end, insert: text },
						selection: { anchor: start + text.length },
					});
				},
				setPreview() {
					// Dictation writes real text through `writeDictation`; a ghost value
					// would double it. Kept for hosts that have no write path at all.
				},
				writeDictation(committed, hypothesis, restart) {
					const view = viewRef.current;
					if (!view) return;
					if (restart) {
						const selection = view.state.selection.main;
						dictationRef.current = {
							origin: view.state.doc.toString(),
							start: selection.from,
							end: selection.to,
						};
					}
					const region = dictationRef.current;
					if (!region) return;
					const next = dictationSplice(
						{ text: region.origin, start: region.start, end: region.end, committed },
						hypothesis,
					);
					const doc = view.state.doc.toString();
					// Write ONLY what the dictation owns. Replacing the whole document
					// would rebuild the editor's content on every decode, which both
					// threw the caret around and replayed every character's entrance
					// animation. Here a growing phrase extends its own tail, so the
					// per-character effect plays for the new glyphs and nothing else.
					const previous = dictationFieldRange(view);
					const { ins: block } = next;
					// The live document's region spans the previous block — or, on the
					// first write, the start caret and any replaced selection. Either
					// can be stale: the document may have been replaced wholesale while
					// a hypothesis was in flight (a send that cleared the composer, a
					// draft restore, the user selecting everything). Handing such an
					// offset to CodeMirror throws "Invalid change range N to M", which
					// takes the whole render tree down, so verify before dispatching.
					const replaceFrom = previous ? previous.from : region.start;
					const replaceTo = previous ? previous.to : region.end;
					const fits = replaceFrom >= 0 && replaceFrom <= replaceTo && replaceTo <= doc.length;
					if (!fits) {
						// The region no longer describes this document. Dropping the
						// write keeps the user's text intact; guessing where the words
						// belonged is how a draft gets corrupted instead.
						dictationRef.current = null;
						view.dispatch({ effects: setDictationRangeEffect.of(null) });
						return;
					}
					// The block starts AFTER the lead separator, but the first write lands
					// at the bare caret, so it must carry that separator itself. Without
					// it the document lost the space while the tracked range still
					// assumed it, sitting one character to the right of the real words:
					// the next write then kept the first character and wrote the phrase
					// again after it ("测" + "测试…") whenever the draft already had text.
					const lead = previous
						? ""
						: next.value.slice(
								region.start <= region.origin.length ? Math.max(0, region.start) : region.origin.length,
								next.from,
							);
					const insert = `${lead}${block}`;
					const current = doc.slice(replaceFrom, replaceTo);
					if (current !== insert) {
						view.dispatch({
							changes: { from: replaceFrom, to: replaceTo, insert },
							selection: { anchor: replaceFrom + insert.length },
							annotations: dictationWriteAnnotation.of(true),
						});
					}
					const from = Math.min(replaceFrom + lead.length, view.state.doc.length);
					const to = Math.min(from + block.length, view.state.doc.length);
					view.dispatch({ effects: setDictationRangeEffect.of({ from, to }) });
					setDocEmpty(view.state.doc.length === 0);
					view.requestMeasure();
				},
				commitDictation() {
					const view = viewRef.current;
					dictationRef.current = null;
					if (!view) return;
					view.dispatch({ effects: setDictationRangeEffect.of(null) });
				},
				cancelDictation() {
					const view = viewRef.current;
					const region = dictationRef.current;
					dictationRef.current = null;
					if (!view) return;
					// Restore the pre-dictation document exactly, rather than deleting
					// the decorated range: the write may have added a separating space
					// on either side, and deleting only the words would leave the seams
					// ("before after" collapsing into "beforeafter").
					if (!region) return;
					const doc = view.state.doc.toString();
					if (doc !== region.origin) {
						view.dispatch({
							changes: { from: 0, to: doc.length, insert: region.origin },
							selection: { anchor: Math.min(region.start, region.origin.length) },
						});
					}
					view.dispatch({ effects: setDictationRangeEffect.of(null) });
					setDocEmpty(view.state.doc.length === 0);
					view.requestMeasure();
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

		// A dictation write changes the view BEFORE the parent's `value` prop has
		// round-tripped through onChange, so the hint must follow the document
		// itself. `docEmpty` is kept in state rather than read off the view: a
		// render-time read would not re-render when only the view changed.
		return (
			<div
				ref={hostRef}
				className={`musepi-composer-editor musepi-composer-editor--${variant}${className ? ` ${className}` : ""}`}
				data-focused={dataFocused ? "1" : "0"}
				data-editable={editable ? "1" : "0"}
				{...(morphId ? { "data-morph-id": morphId } : {})}
				{...(dataComposerInput ? { "data-composer-input": "" } : {})}
			>
				{/* Dictation writes REAL text into the document, so a dictated word is
				 * already enough to retire the hint — there is no separate ghost to
				 * yield to any more. Read from the live view rather than the `value`
				 * prop: the prop only catches up after onChange and a parent render,
				 * and in that gap the hint painted over the words just written. */}
				{docEmpty && placeholder ? (
					<span className="musepi-composer-editor__placeholder" aria-hidden>
						{placeholder}
					</span>
				) : null}
				{pop ? <ComposerMentionPop pop={pop} /> : null}
			</div>
		);
	},
);
