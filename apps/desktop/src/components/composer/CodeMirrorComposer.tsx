import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { Annotation, EditorState, type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComposerEditorHandle } from "./editor-types";
import { type HighlightKind, HL_CLASS, type MentionPreview, parseHighlightSpans } from "./input-highlight";

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

export interface ComposerSelection {
	start: number;
	end: number;
}

export interface CodeMirrorComposerProps {
	value: string;
	onChange(value: string, selection: ComposerSelection): void;
	onKeyDown?(event: KeyboardEvent): boolean | void;
	onPaste?(event: ClipboardEvent): void;
	onDragOver?(event: DragEvent): void;
	onDrop?(event: DragEvent): void;
	onFocus?(): void;
	onBlur?(): void;
	onCompositionStart?(): void;
	onCompositionEnd?(): void;
	placeholder?: string;
	spellCheck?: boolean;
	autoComplete?: string;
	/** Resolve a mention name against the live chip list; null = plain text. */
	resolveMention?(name: string): MentionPreview | null;
	/** Recompute mention decorations when the chip list changes. */
	mentionVersion?: unknown;
	onMentionClick?(start: number): void;
	className?: string;
	dataComposerInput?: boolean;
	dataFocused?: boolean;
	variant?: "session" | "welcome";
	ariaLabel?: string;
	autoFocus?: boolean;
}

interface MentionPop {
	name: string;
	preview: MentionPreview;
	x: number;
	y: number;
}

const valuePropWrite = Annotation.define<true>();
const refreshTokens = StateEffect.define<null>();

const TOKEN_MARK: Record<HighlightKind, Decoration> = {
	slash: Decoration.mark({ class: HL_CLASS.slash }),
	bang: Decoration.mark({ class: HL_CLASS.bang }),
	magic: Decoration.mark({ class: HL_CLASS.magic }),
	mention: Decoration.mark({ class: HL_CLASS.mention }),
};

function tokenField(
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

function selectionOf(state: EditorState): ComposerSelection {
	return { start: state.selection.main.from, end: state.selection.main.to };
}

/** Map a document offset across an external whole-document replacement by its
 *  unchanged prefix/suffix; an offset inside the changed middle clamps to the
 *  change start. An empty old document maps to the end (a restored prompt
 *  should put the caret after its text). */
function mapPosition(oldText: string, nextText: string, position: number): number {
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

export const CodeMirrorComposer = forwardRef<ComposerEditorHandle, CodeMirrorComposerProps>(
	function CodeMirrorComposer(props, ref) {
		const {
			value,
			onChange,
			onKeyDown,
			onPaste,
			onDragOver,
			onDrop,
			onFocus,
			onBlur,
			onCompositionStart,
			onCompositionEnd,
			placeholder,
			spellCheck = false,
			autoComplete = "off",
			resolveMention,
			mentionVersion,
			onMentionClick,
			className,
			dataComposerInput = false,
			dataFocused = false,
			variant = "session",
			ariaLabel,
			autoFocus = false,
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
			onDrop,
			onFocus,
			onBlur,
			onCompositionStart,
			onCompositionEnd,
			onMentionClick,
		};
		const resolverRef = useRef(resolveMention);
		resolverRef.current = resolveMention;
		const spansRef = useRef<ReturnType<typeof parseHighlightSpans>>([]);
		const [pop, setPop] = useState<MentionPop | null>(null);

		useLayoutEffect(() => {
			const host = hostRef.current;
			if (!host) return;
			const interceptKeys = [
				{
					any: (_view: EditorView, event: KeyboardEvent): boolean => {
						const handled = handlersRef.current.onKeyDown?.(event);
						return handled === true || event.defaultPrevented;
					},
				},
			];
			const view = new EditorView({
				state: EditorState.create({
					doc: valueRef.current,
					extensions: [
						history(),
						EditorView.lineWrapping,
						// Composer keys win over CodeMirror defaults (Enter sends,
						// ArrowUp walks history, Backspace removes a mention atom).
						Prec.highest(keymap.of(interceptKeys)),
						keymap.of([...standardKeymap, ...historyKeymap]),
						tokenField(resolverRef, spansRef),
						EditorView.updateListener.of(update => {
							const handlers = handlersRef.current;
							if (update.docChanged) {
								const programmatic = update.transactions.every(
									transaction => !transaction.docChanged || transaction.annotation(valuePropWrite) === true,
								);
								setPop(null);
								if (!programmatic) {
									handlers.onChange(update.state.doc.toString(), selectionOf(update.state));
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
								const coords = editor.coordsAtPos(at.span.start);
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
								handlersRef.current.onMentionClick?.(at.span.start);
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

		// External value writes (completion, undo backfill, voice, enhance):
		// replace the document, keep the caret at the end like a controlled
		// textarea, and mark the transaction so onChange does not echo it back.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			const current = view.state.doc.toString();
			if (current === value) return;
			const apply = (): void => {
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
			viewRef.current?.dispatch({ effects: refreshTokens.of(null) });
			// The resolver itself is read through resolverRef; only the chip
			// list identity changes what "resolved" means.
		}, [mentionVersion]);

		function mentionAt(
			editor: EditorView,
			event: MouseEvent,
		): { span: ReturnType<typeof parseHighlightSpans>[number]; name: string } | null {
			const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos === null) return null;
			const doc = editor.state.doc.toString();
			for (const span of spansRef.current) {
				if (span.kind !== "mention" || pos < span.start || pos > span.end) continue;
				const raw = doc.slice(span.start, span.end);
				return { span, name: raw.startsWith("@") || raw.startsWith("＠") ? raw.slice(1) : raw };
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
				autosize() {
					const view = viewRef.current;
					const host = hostRef.current;
					if (!view || !host) return;
					const style = getComputedStyle(view.contentDOM);
					const lineHeight = Number.parseFloat(style.lineHeight) || 20;
					const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
					const rows = variant === "welcome" ? 3 : 2;
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
				className={`gui-cm-composer gui-cm-composer--${variant}${className ? ` ${className}` : ""}`}
				data-focused={dataFocused ? "1" : "0"}
				{...(dataComposerInput ? { "data-composer-input": "" } : {})}
			>
				{value.length === 0 && placeholder ? (
					<span className="gui-cm-placeholder" aria-hidden>
						{placeholder}
					</span>
				) : null}
				{pop
					? createPortal(
							<div className="gui-mention-pop" style={{ left: `${pop.x}px`, top: `${pop.y - 8}px` }} aria-hidden>
								{pop.preview.kind === "image" && pop.preview.dataUrl ? (
									<img className="gui-mention-pop-thumb" src={pop.preview.dataUrl} alt="" draggable={false} />
								) : null}
								<span className="gui-mention-pop-name">{pop.preview.name}</span>
								{mentionSizeLabel(pop.preview.size) && (
									<span className="gui-mention-pop-size">{mentionSizeLabel(pop.preview.size)}</span>
								)}
							</div>,
							document.body,
						)
					: null}
			</div>
		);
	},
);

function mentionSizeLabel(size: number | undefined): string {
	if (!size || !Number.isFinite(size) || size <= 0) return "";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
