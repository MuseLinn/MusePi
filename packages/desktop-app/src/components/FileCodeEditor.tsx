import type * as Monaco from "monaco-editor";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { EditorLocation } from "../lib/editor-navigation";
import {
	adoptMonacoPeekModel,
	disposeMonacoPeekModels,
	type MonacoPeekBuffer,
	markMonacoPeekFileSaved,
	prepareMonacoDefinitionPeek,
	prepareMonacoReferencesPeek,
	registerMonacoLanguageFeatures,
} from "../lib/monaco-lsp";
import { loadMonaco, observeMonacoTheme } from "../lib/monaco-runtime";
import type { RpcClient } from "../lib/rpc";

export function createFileEditorModel(monaco: typeof Monaco, path: string, value: string): Monaco.editor.ITextModel {
	const uri = monaco.Uri.file(path);
	const existing = monaco.editor.getModel(uri);
	const model = existing ?? monaco.editor.createModel(value, undefined, uri);
	adoptMonacoPeekModel(monaco, path);
	model.updateOptions({ tabSize: 2, insertSpaces: true });
	return model;
}

export interface FileEditorSelection {
	text: string;
	path: string;
	language: string;
	startLine: number;
	endLine: number;
	x: number;
	y: number;
	height: number;
}

/** Translate Monaco's model selection into the viewport coordinates used by
 * the shared selection toolbar. The editor and container share an origin. */
export function readFileEditorSelection(
	editor: Monaco.editor.IStandaloneCodeEditor,
	container: HTMLElement,
	path: string,
): FileEditorSelection | null {
	const range = editor.getSelection();
	const model = editor.getModel();
	if (!range || !model || range.isEmpty()) return null;
	const text = model.getValueInRange(range);
	if (!text.trim()) return null;
	const position = editor.getScrolledVisiblePosition(range.getStartPosition());
	if (!position) return null;
	const bounds = container.getBoundingClientRect();
	return {
		text,
		path,
		language: model.getLanguageId(),
		startLine: range.startLineNumber,
		endLine: range.endLineNumber,
		x: Math.round(bounds.left + position.left),
		y: Math.round(bounds.top + position.top),
		height: position.height,
	};
}

export function readFileEditorPosition(
	editor: Monaco.editor.IStandaloneCodeEditor,
	path: string,
): EditorLocation | null {
	const position = editor.getPosition();
	return position ? { path, lineNumber: position.lineNumber, column: position.column } : null;
}

interface FileCodeEditorProps {
	rpc: RpcClient;
	cwd: string;
	path: string;
	value: string;
	name: string;
	onChange(text: string): void;
	onSave(text: string): void;
	onNavigate(source: EditorLocation, target: EditorLocation): void;
	onPositionChange(location: EditorLocation): void;
	onHistoryBack(): void;
	onHistoryForward(): void;
	onLoadFile(path: string): Promise<MonacoPeekBuffer | null>;
	onSaveFile(path: string, text: string): Promise<boolean>;
	onBufferChange(buffer: MonacoPeekBuffer): void;
	onSelectionChange(selection: FileEditorSelection | null): void;
}

/** A FilePane editing surface. FilePane remains the text authority; this
 * component owns only Monaco's view, model lifetime, and editor commands. */
export function FileCodeEditor({
	rpc,
	cwd,
	path,
	value,
	name,
	onChange,
	onSave,
	onNavigate,
	onPositionChange,
	onHistoryBack,
	onHistoryForward,
	onLoadFile,
	onSaveFile,
	onBufferChange,
	onSelectionChange,
}: FileCodeEditorProps): ReactNode {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const monacoRef = useRef<typeof Monaco | null>(null);
	const valueRef = useRef(value);
	const callbacksRef = useRef({
		onChange,
		onSave,
		onNavigate,
		onPositionChange,
		onHistoryBack,
		onHistoryForward,
		onLoadFile,
		onSaveFile,
		onBufferChange,
		onSelectionChange,
	});
	const [ready, setReady] = useState(false);
	const [failed, setFailed] = useState(false);
	valueRef.current = value;
	callbacksRef.current = {
		onChange,
		onSave,
		onNavigate,
		onPositionChange,
		onHistoryBack,
		onHistoryForward,
		onLoadFile,
		onSaveFile,
		onBufferChange,
		onSelectionChange,
	};

	useEffect(() => {
		let cancelled = false;
		let observer: MutationObserver | null = null;
		let languageFeatures: Monaco.IDisposable | null = null;
		setReady(false);
		setFailed(false);
		void loadMonaco()
			.then(monaco => {
				const container = containerRef.current;
				if (cancelled || !container) return;
				const model = createFileEditorModel(monaco, path, valueRef.current);
				const editor = monaco.editor.create(container, {
					model,
					ariaLabel: name,
					automaticLayout: true,
					detectIndentation: false,
					fixedOverflowWidgets: true,
					folding: true,
					fontFamily: getComputedStyle(container).getPropertyValue("--font-mono").trim() || "monospace",
					fontSize: 12,
					glyphMargin: false,
					insertSpaces: true,
					lineDecorationsWidth: 8,
					lineHeight: 20,
					lineNumbers: "on",
					lineNumbersMinChars: 3,
					minimap: { enabled: false },
					overviewRulerBorder: false,
					padding: { top: 8, bottom: 8 },
					scrollBeyondLastLine: false,
					scrollbar: { useShadows: false },
					stickyScroll: { enabled: false },
					tabSize: 2,
					wordWrap: "off",
				});
				editorRef.current = editor;
				monacoRef.current = monaco;
				editor.onDidChangeModelContent(() => {
					callbacksRef.current.onChange(editor.getValue());
				});
				// A peek may have loaded or edited this document before its tab opened.
				callbacksRef.current.onChange(model.getValue());
				const publishPosition = (): void => {
					const location = readFileEditorPosition(editor, path);
					if (location) callbacksRef.current.onPositionChange(location);
				};
				const publishSelection = (): void =>
					callbacksRef.current.onSelectionChange(readFileEditorSelection(editor, container, path));
				editor.onDidChangeCursorSelection(() => {
					publishPosition();
					publishSelection();
				});
				editor.onDidScrollChange(publishSelection);
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
					callbacksRef.current.onSave(editor.getValue()),
				);
				editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, () => callbacksRef.current.onHistoryBack());
				editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, () =>
					callbacksRef.current.onHistoryForward(),
				);
				const openLocationPeek = async (kind: "definition" | "references"): Promise<void> => {
					const anchor = editor.getPosition();
					const prepare = kind === "definition" ? prepareMonacoDefinitionPeek : prepareMonacoReferencesPeek;
					await prepare(
						monaco,
						rpc,
						cwd,
						editor,
						filePath => callbacksRef.current.onLoadFile(filePath),
						buffer => callbacksRef.current.onBufferChange(buffer),
					);
					const current = editor.getPosition();
					if (
						cancelled ||
						!anchor ||
						!current ||
						current.lineNumber !== anchor.lineNumber ||
						current.column !== anchor.column
					) {
						return;
					}
					editor.trigger(
						"musepi",
						kind === "definition" ? "editor.action.peekDefinition" : "editor.action.referenceSearch.trigger",
						null,
					);
				};
				// VS Code's go-to commands remain native Monaco actions. These explicit
				// bindings keep them available in the standalone editor keymap.
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12, () =>
					editor.trigger("musepi", "editor.action.goToImplementation", null),
				);
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.F12, () =>
					editor.trigger("musepi", "editor.action.goToTypeDefinition", null),
				);
				editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.F12, () => void openLocationPeek("definition"));
				editor.addCommand(
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.F10,
					() => void openLocationPeek("definition"),
				);
				editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F12, () => void openLocationPeek("references"));
				languageFeatures = registerMonacoLanguageFeatures(
					monaco,
					rpc,
					cwd,
					editor,
					(source, target) => callbacksRef.current.onNavigate(source, target),
					filePath => callbacksRef.current.onLoadFile(filePath),
					buffer => callbacksRef.current.onBufferChange(buffer),
				);
				publishPosition();
				observer = observeMonacoTheme(monaco);
				editor.focus();
				setReady(true);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
			observer?.disconnect();
			languageFeatures?.dispose();
			disposeMonacoPeekModels();
			const editor = editorRef.current;
			editorRef.current = null;
			monacoRef.current = null;
			const model = editor?.getModel();
			editor?.dispose();
			model?.dispose();
		};
		// The current value seeds a new document. Later React renders only echo
		// Monaco's own onChange; writing them back would let an older render reset
		// the cursor, selection, undo stack, or an active IME composition.
	}, [rpc, cwd, path, name]);

	if (failed) {
		return (
			<textarea
				className="gui-filepane-editor-text"
				value={value}
				aria-label={name}
				spellCheck={false}
				autoFocus
				onChange={event => onChange(event.target.value)}
				onSelect={event => {
					const control = event.currentTarget;
					const start = control.selectionStart;
					const end = control.selectionEnd;
					const startLine = control.value.slice(0, start).split("\n").length;
					onPositionChange({
						path,
						lineNumber: startLine,
						column: start - control.value.lastIndexOf("\n", start - 1),
					});
					const text = control.value.slice(start, end);
					if (!text.trim()) {
						onSelectionChange(null);
						return;
					}
					const bounds = control.getBoundingClientRect();
					onSelectionChange({
						text,
						path,
						language: name.split(".").at(-1) ?? "txt",
						startLine,
						endLine: startLine + text.split("\n").length - 1,
						x: Math.round(bounds.left + 12),
						y: Math.round(bounds.top + Math.min(bounds.height - 20, (startLine - 1) * 20)),
						height: 20,
					});
				}}
				onKeyDown={event => {
					if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
						event.preventDefault();
						if (event.key === "ArrowLeft") onHistoryBack();
						else onHistoryForward();
					} else if ((event.metaKey || event.ctrlKey) && event.key === "s") {
						event.preventDefault();
						onSave(event.currentTarget.value);
					}
				}}
			/>
		);
	}
	return (
		<div
			ref={containerRef}
			className="gui-filepane-editor-monaco"
			data-ready={ready || undefined}
			onKeyDownCapture={event => {
				if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "s") return;
				const monaco = monacoRef.current;
				const mainEditor = editorRef.current;
				const focusedEditor = monaco?.editor.getEditors().find(candidate => candidate.hasTextFocus());
				const focusedModel = focusedEditor?.getModel();
				if (!monaco || !mainEditor || !focusedModel || focusedModel === mainEditor.getModel()) return;
				event.preventDefault();
				event.stopPropagation();
				const filePath = focusedModel.uri.fsPath;
				const text = focusedModel.getValue();
				void callbacksRef.current.onSaveFile(filePath, text).then(saved => {
					if (saved) markMonacoPeekFileSaved(monaco, filePath, text);
				});
			}}
		/>
	);
}
