import type * as Monaco from "monaco-editor";
import type { EditorLocation } from "./editor-navigation";
import type { RpcClient } from "./rpc";

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspDiagnostic {
	range: LspRange;
	severity?: 1 | 2 | 3 | 4;
	code?: string | number;
	codeDescription?: { href: string };
	source?: string;
	message: string;
}

interface LspMarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

interface LspMarkedString {
	language: string;
	value: string;
}

interface LspTextEdit {
	range?: LspRange;
	insert?: LspRange;
	replace?: LspRange;
	newText: string;
}

interface LspCompletionItem {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string | LspMarkupContent;
	sortText?: string;
	filterText?: string;
	insertText?: string;
	insertTextFormat?: 1 | 2;
	textEdit?: LspTextEdit;
	commitCharacters?: string[];
	preselect?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRange(value: unknown): value is LspRange {
	return (
		isRecord(value) &&
		isRecord(value.start) &&
		isRecord(value.end) &&
		typeof value.start.line === "number" &&
		typeof value.start.character === "number" &&
		typeof value.end.line === "number" &&
		typeof value.end.character === "number"
	);
}

/** LSP positions are zero-based; Monaco lines and columns are one-based. */
export function toMonacoRange(range: LspRange): Monaco.IRange {
	return {
		startLineNumber: range.start.line + 1,
		startColumn: range.start.character + 1,
		endLineNumber: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

export function toMonacoMarkers(
	monaco: typeof Monaco,
	diagnostics: readonly LspDiagnostic[],
): Monaco.editor.IMarkerData[] {
	const severities = {
		1: monaco.MarkerSeverity.Error,
		2: monaco.MarkerSeverity.Warning,
		3: monaco.MarkerSeverity.Info,
		4: monaco.MarkerSeverity.Hint,
	};
	return diagnostics.map(diagnostic => ({
		...toMonacoRange(diagnostic.range),
		severity: severities[diagnostic.severity ?? 1],
		message: diagnostic.message,
		source: diagnostic.source,
		code:
			typeof diagnostic.code === "number" || typeof diagnostic.code === "string"
				? String(diagnostic.code)
				: undefined,
	}));
}

function markdownValue(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!isRecord(content) || typeof content.value !== "string") return null;
	if (typeof content.language === "string") return `\`\`\`${content.language}\n${content.value}\n\`\`\``;
	return content.value;
}

export function toMonacoHover(result: unknown): Monaco.languages.Hover | null {
	if (!isRecord(result)) return null;
	const rawContents = Array.isArray(result.contents) ? result.contents : [result.contents];
	const contents = rawContents.flatMap(content => {
		const value = markdownValue(content);
		return value === null ? [] : [{ value }];
	});
	if (contents.length === 0) return null;
	return {
		contents,
		...(isRange(result.range) ? { range: toMonacoRange(result.range) } : {}),
	};
}

function completionKind(monaco: typeof Monaco, kind: number | undefined): Monaco.languages.CompletionItemKind {
	const kinds = monaco.languages.CompletionItemKind;
	const mapping: Record<number, Monaco.languages.CompletionItemKind> = {
		1: kinds.Text,
		2: kinds.Method,
		3: kinds.Function,
		4: kinds.Constructor,
		5: kinds.Field,
		6: kinds.Variable,
		7: kinds.Class,
		8: kinds.Interface,
		9: kinds.Module,
		10: kinds.Property,
		11: kinds.Unit,
		12: kinds.Value,
		13: kinds.Enum,
		14: kinds.Keyword,
		15: kinds.Snippet,
		16: kinds.Color,
		17: kinds.File,
		18: kinds.Reference,
		19: kinds.Folder,
		20: kinds.EnumMember,
		21: kinds.Constant,
		22: kinds.Struct,
		23: kinds.Event,
		24: kinds.Operator,
		25: kinds.TypeParameter,
	};
	return kind !== undefined && mapping[kind] !== undefined ? mapping[kind] : kinds.Text;
}

function completionDocumentation(item: LspCompletionItem): string | Monaco.IMarkdownString | undefined {
	if (typeof item.documentation === "string") return item.documentation;
	return item.documentation ? { value: item.documentation.value } : undefined;
}

export function toMonacoCompletionList(
	monaco: typeof Monaco,
	result: unknown,
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
): Monaco.languages.CompletionList {
	const rawItems = Array.isArray(result)
		? result
		: isRecord(result) && Array.isArray(result.items)
			? result.items
			: [];
	const word = model.getWordUntilPosition(position);
	const defaultRange: Monaco.IRange = {
		startLineNumber: position.lineNumber,
		startColumn: word.startColumn,
		endLineNumber: position.lineNumber,
		endColumn: word.endColumn,
	};
	const suggestions = rawItems.flatMap((raw): Monaco.languages.CompletionItem[] => {
		if (!isRecord(raw) || typeof raw.label !== "string") return [];
		const item = raw as unknown as LspCompletionItem;
		// The client advertises snippetSupport:false. Ignore a non-conforming
		// snippet rather than inserting its $0/${1} control bytes as plain text.
		if (item.insertTextFormat === 2) return [];
		const editRange = item.textEdit?.range ?? item.textEdit?.replace ?? item.textEdit?.insert;
		return [
			{
				label: item.label,
				kind: completionKind(monaco, item.kind),
				detail: item.detail,
				documentation: completionDocumentation(item),
				sortText: item.sortText,
				filterText: item.filterText,
				insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
				range: editRange ? toMonacoRange(editRange) : defaultRange,
				commitCharacters: item.commitCharacters,
				preselect: item.preselect,
			},
		];
	});
	return {
		suggestions,
		incomplete: isRecord(result) && result.isIncomplete === true,
	};
}

export function toMonacoDefinitions(monaco: typeof Monaco, result: unknown): Monaco.languages.Location[] {
	const locations = Array.isArray(result) ? result : result ? [result] : [];
	return locations.flatMap(location => {
		if (!isRecord(location)) return [];
		const uri = typeof location.uri === "string" ? location.uri : location.targetUri;
		const range = location.targetSelectionRange ?? location.targetRange ?? location.range;
		if (typeof uri !== "string" || !isRange(range)) return [];
		return [{ uri: monaco.Uri.parse(uri), range: toMonacoRange(range) }];
	});
}

/** Convert only textual WorkspaceEdits. A resource operation makes the whole
 * rename fail before Monaco applies anything, so no file is left half-renamed. */
export function toMonacoRenameEdit(
	monaco: typeof Monaco,
	result: unknown,
): Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection {
	if (result === null || result === undefined) return { edits: [] };
	if (!isRecord(result)) {
		return { edits: [], rejectReason: "The language server returned an invalid rename edit; no edits were applied." };
	}
	const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
	let rejected = false;
	let rejectReason: string | undefined;
	const reject = (reason: string): void => {
		rejected = true;
		rejectReason = reason;
	};
	const append = (uri: unknown, rawEdits: unknown): void => {
		if (rejected) return;
		if (typeof uri !== "string" || !Array.isArray(rawEdits)) {
			reject("The language server returned an invalid rename edit; no edits were applied.");
			return;
		}
		for (const rawEdit of rawEdits) {
			if (!isRecord(rawEdit) || !isRange(rawEdit.range) || typeof rawEdit.newText !== "string") {
				reject("The language server returned an invalid rename edit; no edits were applied.");
				return;
			}
			edits.push({
				resource: monaco.Uri.parse(uri),
				textEdit: { range: toMonacoRange(rawEdit.range), text: rawEdit.newText },
				versionId: undefined,
			});
		}
	};
	if (result.changes !== undefined) {
		if (!isRecord(result.changes))
			reject("The language server returned an invalid rename edit; no edits were applied.");
		else for (const [uri, rawEdits] of Object.entries(result.changes)) append(uri, rawEdits);
	}
	if (result.documentChanges !== undefined) {
		if (!Array.isArray(result.documentChanges)) {
			reject("The language server returned an invalid rename edit; no edits were applied.");
		} else {
			for (const change of result.documentChanges) {
				if (rejected) break;
				if (isRecord(change) && typeof change.kind === "string") {
					reject("Rename resource operations are not supported; no edits were applied.");
				} else if (isRecord(change) && isRecord(change.textDocument)) {
					append(change.textDocument.uri, change.edits);
				} else {
					reject("The language server returned an invalid rename edit; no edits were applied.");
				}
			}
		}
	}
	return rejected ? { edits: [], rejectReason } : { edits };
}

interface EditorDocument {
	rpc: RpcClient;
	cwd: string;
	editor: Monaco.editor.IStandaloneCodeEditor;
	onNavigate(source: EditorLocation, target: EditorLocation): void;
	loadFile?: (path: string) => Promise<MonacoPeekBuffer | null>;
	onBufferChange?: (buffer: MonacoPeekBuffer) => void;
}

export interface MonacoPeekBuffer {
	path: string;
	text: string;
	saved: string;
}

interface PeekModelEntry {
	model: Monaco.editor.ITextModel;
	saved: string;
	changeListener: Monaco.IDisposable;
	publish(): void;
}

const documents = new Map<string, EditorDocument>();
const pendingPositions = new Map<string, Monaco.IPosition>();
const providerRegistrations = new Map<string, { count: number; disposables: Monaco.IDisposable[] }>();
const peekModels = new Map<string, PeekModelEntry>();
let editorOpener: Monaco.IDisposable | null = null;
let monacoRuntime: typeof Monaco | null = null;
let pendingEditorLocation: EditorLocation | null = null;
const MARKER_OWNER = "musepi-lsp";
const DIAGNOSTICS_DEBOUNCE_MS = 300;

/** A full file editor adopts a peek-loaded model and becomes its lifetime owner. */
export function adoptMonacoPeekModel(monaco: typeof Monaco, path: string): void {
	const uri = monaco.Uri.file(path).toString();
	const entry = peekModels.get(uri);
	if (!entry) return;
	entry.changeListener.dispose();
	peekModels.delete(uri);
}

/** Release models loaded only for peek or rename. Publish the final value before
 * disposal so a bulk edit adjacent to a tab switch cannot lose its dirty draft. */
export function disposeMonacoPeekModels(): void {
	for (const entry of peekModels.values()) {
		entry.publish();
		entry.changeListener.dispose();
		if (!entry.model.isDisposed()) entry.model.dispose();
	}
	peekModels.clear();
}

/** Monaco's native peek resolves existing models but does not read disk. Load
 * each missing definition target before invoking its peek command. */
export function prepareMonacoDefinitionPeek(
	monaco: typeof Monaco,
	rpc: RpcClient,
	cwd: string,
	editor: Monaco.editor.IStandaloneCodeEditor,
	loadFile: (path: string) => Promise<MonacoPeekBuffer | null>,
	onChange: (buffer: MonacoPeekBuffer) => void,
): Promise<void> {
	return prepareMonacoLocationPeek(monaco, rpc, cwd, editor, "editor.definition", loadFile, onChange);
}

/** Native reference peek includes declarations. Mirror that filter while
 * preloading the files so its second request sees the same result set. */
export function prepareMonacoReferencesPeek(
	monaco: typeof Monaco,
	rpc: RpcClient,
	cwd: string,
	editor: Monaco.editor.IStandaloneCodeEditor,
	loadFile: (path: string) => Promise<MonacoPeekBuffer | null>,
	onChange: (buffer: MonacoPeekBuffer) => void,
): Promise<void> {
	return prepareMonacoLocationPeek(monaco, rpc, cwd, editor, "editor.references", loadFile, onChange);
}

async function ensureMonacoBufferModel(
	monaco: typeof Monaco,
	uri: Monaco.Uri,
	loadFile: (path: string) => Promise<MonacoPeekBuffer | null>,
	onChange: (buffer: MonacoPeekBuffer) => void,
): Promise<Monaco.editor.ITextModel | null> {
	const existing = monaco.editor.getModel(uri);
	if (existing) return existing;
	const buffer = await loadFile(uri.fsPath);
	if (!buffer) return null;
	const raced = monaco.editor.getModel(uri);
	if (raced) return raced;
	const model = monaco.editor.createModel(buffer.text, undefined, uri);
	model.updateOptions({ tabSize: 2, insertSpaces: true });
	const entry: PeekModelEntry = {
		model,
		saved: buffer.saved,
		changeListener: { dispose: () => {} },
		publish: () => {},
	};
	entry.publish = () => {
		if (!model.isDisposed()) onChange({ path: model.uri.fsPath, text: model.getValue(), saved: entry.saved });
	};
	entry.changeListener = model.onDidChangeContent(entry.publish);
	peekModels.set(uri.toString(), entry);
	return model;
}

async function prepareMonacoLocationPeek(
	monaco: typeof Monaco,
	rpc: RpcClient,
	cwd: string,
	editor: Monaco.editor.IStandaloneCodeEditor,
	method: "editor.definition" | "editor.references",
	loadFile: (path: string) => Promise<MonacoPeekBuffer | null>,
	onChange: (buffer: MonacoPeekBuffer) => void,
): Promise<void> {
	const model = editor.getModel();
	const position = editor.getPosition();
	if (!model || !position) return;
	disposeMonacoPeekModels();
	const cancellation = new monaco.CancellationTokenSource();
	try {
		const result = await positionRequest(
			rpc,
			method,
			cwd,
			model,
			position,
			cancellation.token,
			method === "editor.references" ? { includeDeclaration: true } : undefined,
		);
		for (const location of toMonacoDefinitions(monaco, result)) {
			if (location.uri.scheme !== "file" || monaco.editor.getModel(location.uri)) continue;
			await ensureMonacoBufferModel(monaco, location.uri, loadFile, onChange);
		}
	} finally {
		cancellation.dispose();
	}
}

/** BulkEdit needs a model for every target. Load all of them before returning
 * the edit, and reject the whole rename if any target cannot participate. */
async function prepareMonacoRenameTargets(
	monaco: typeof Monaco,
	edit: Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection,
	loadFile: (path: string) => Promise<MonacoPeekBuffer | null>,
	onChange: (buffer: MonacoPeekBuffer) => void,
	token: Monaco.CancellationToken,
): Promise<Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection> {
	if (edit.rejectReason) return edit;
	const resources = new Map<string, Monaco.Uri>();
	for (const item of edit.edits) {
		if ("resource" in item) resources.set(item.resource.toString(), item.resource);
	}
	for (const resource of resources.values()) {
		if (token.isCancellationRequested) return { edits: [] };
		if (resource.scheme !== "file") {
			return { edits: [], rejectReason: "Rename supports file documents only; no edits were applied." };
		}
		const model = await ensureMonacoBufferModel(monaco, resource, loadFile, onChange);
		if (!model) return { edits: [], rejectReason: "A rename target could not be loaded; no edits were applied." };
	}
	return token.isCancellationRequested ? { edits: [] } : edit;
}

/** A successful peek save advances only the saved baseline. Text typed while
 * the write was pending remains dirty through the following publication. */
export function markMonacoPeekFileSaved(monaco: typeof Monaco, path: string, text: string): void {
	const entry = peekModels.get(monaco.Uri.file(path).toString());
	if (!entry) return;
	entry.saved = text;
	entry.publish();
}

async function positionRequest(
	rpc: RpcClient,
	method:
		| "editor.hover"
		| "editor.completion"
		| "editor.definition"
		| "editor.implementation"
		| "editor.typeDefinition"
		| "editor.references"
		| "editor.rename",
	cwd: string,
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
	token: Monaco.CancellationToken,
	additional?: { includeDeclaration?: boolean; newName?: string },
): Promise<unknown | null> {
	if (token.isCancellationRequested) return null;
	try {
		const response = await rpc.request<{ available: boolean; result: unknown | null }>(
			method,
			{
				cwd,
				path: model.uri.fsPath,
				content: model.getValue(),
				line: position.lineNumber - 1,
				character: position.column - 1,
				...additional,
			},
			{ timeoutMs: 12_000 },
		);
		return token.isCancellationRequested || !response.available ? null : response.result;
	} catch {
		return null;
	}
}

function selectionPosition(selection: Monaco.IRange | Monaco.IPosition | undefined): Monaco.IPosition | null {
	if (!selection) return null;
	return "lineNumber" in selection
		? selection
		: { lineNumber: selection.startLineNumber, column: selection.startColumn };
}

function revealPosition(editor: Monaco.editor.ICodeEditor, position: Monaco.IPosition): void {
	editor.setPosition(position);
	editor.revealPositionInCenter(position);
}

function revealOrQueuePosition(monaco: typeof Monaco, path: string, position: Monaco.IPosition): void {
	const resource = monaco.Uri.file(path);
	const target = documents.get(resource.toString());
	if (target) {
		revealPosition(target.editor, position);
		target.editor.focus();
	} else {
		// Tab activation mounts Monaco asynchronously. Consume this position when
		// that exact resource registers its editor.
		pendingPositions.set(resource.toString(), position);
	}
}

/** Reveal a definition or history location through the same adapter. A closed
 * target file queues its position until FileCodeEditor finishes mounting. */
export function revealEditorLocation(location: EditorLocation): void {
	if (monacoRuntime) revealOrQueuePosition(monacoRuntime, location.path, location);
	else pendingEditorLocation = location;
}

/** Release the process-wide opener when its Monaco host is torn down. */
export function disposeMonacoEditorOpener(): void {
	editorOpener?.dispose();
	editorOpener = null;
}

function ensureEditorOpener(monaco: typeof Monaco): void {
	if (editorOpener) return;
	editorOpener = monaco.editor.registerEditorOpener({
		openCodeEditor: (source, resource, selectionOrPosition) => {
			if (resource.scheme !== "file") return false;
			const sourceModel = source.getModel();
			if (!sourceModel) return false;
			const document = documents.get(sourceModel.uri.toString());
			if (!document) return false;
			const sourcePosition = source.getPosition() ?? { lineNumber: 1, column: 1 };
			const targetPosition = selectionPosition(selectionOrPosition) ?? { lineNumber: 1, column: 1 };
			document.onNavigate(
				{ path: sourceModel.uri.fsPath, ...sourcePosition },
				{ path: resource.fsPath, ...targetPosition },
			);
			if (sourceModel.uri.toString() === resource.toString()) {
				revealPosition(source, targetPosition);
				source.focus();
				return true;
			}
			revealOrQueuePosition(monaco, resource.fsPath, targetPosition);
			return true;
		},
	});
}

/** Register one provider set per language, then route each request by model URI.
 * The returned disposal owns only this model's diagnostics and registration
 * reference; a split editor cannot dispose another editor's providers. */
export function registerMonacoLanguageFeatures(
	monaco: typeof Monaco,
	rpc: RpcClient,
	cwd: string,
	editor: Monaco.editor.IStandaloneCodeEditor,
	onNavigate: (source: EditorLocation, target: EditorLocation) => void,
	loadFile?: (path: string) => Promise<MonacoPeekBuffer | null>,
	onBufferChange?: (buffer: MonacoPeekBuffer) => void,
): Monaco.IDisposable {
	const model = editor.getModel();
	if (!model) return { dispose: () => {} };
	const uri = model.uri.toString();
	const document: EditorDocument = { rpc, cwd, editor, onNavigate, loadFile, onBufferChange };
	documents.set(uri, document);
	monacoRuntime = monaco;
	ensureEditorOpener(monaco);
	// Preserve the latest request made while Monaco was dynamically loading.
	const earlyLocation = pendingEditorLocation;
	if (earlyLocation && monaco.Uri.file(earlyLocation.path).toString() === uri) {
		pendingEditorLocation = null;
		revealPosition(editor, earlyLocation);
	}
	const pendingPosition = pendingPositions.get(uri);
	if (pendingPosition) {
		pendingPositions.delete(uri);
		revealPosition(editor, pendingPosition);
	}
	const language = model.getLanguageId();
	let registration = providerRegistrations.get(language);
	if (!registration) {
		const disposables = [
			monaco.languages.registerHoverProvider(language, {
				provideHover: async (source, position, token) => {
					const document = documents.get(source.uri.toString());
					if (!document) return null;
					const result = await positionRequest(
						document.rpc,
						"editor.hover",
						document.cwd,
						source,
						position,
						token,
					);
					return token.isCancellationRequested ? null : toMonacoHover(result);
				},
			}),
			monaco.languages.registerCompletionItemProvider(language, {
				provideCompletionItems: async (source, position, _context, token) => {
					const document = documents.get(source.uri.toString());
					if (!document || token.isCancellationRequested) return { suggestions: [] };
					const result = await positionRequest(
						document.rpc,
						"editor.completion",
						document.cwd,
						source,
						position,
						token,
					);
					return token.isCancellationRequested
						? { suggestions: [] }
						: toMonacoCompletionList(monaco, result, source, position);
				},
			}),
			monaco.languages.registerDefinitionProvider(language, {
				provideDefinition: async (source, position, token) => {
					const document = documents.get(source.uri.toString());
					if (!document) return [];
					const result = await positionRequest(
						document.rpc,
						"editor.definition",
						document.cwd,
						source,
						position,
						token,
					);
					return token.isCancellationRequested ? [] : toMonacoDefinitions(monaco, result);
				},
			}),
			monaco.languages.registerImplementationProvider(language, {
				provideImplementation: async (source, position, token) => {
					const document = documents.get(source.uri.toString());
					if (!document) return [];
					const result = await positionRequest(
						document.rpc,
						"editor.implementation",
						document.cwd,
						source,
						position,
						token,
					);
					return token.isCancellationRequested ? [] : toMonacoDefinitions(monaco, result);
				},
			}),
			monaco.languages.registerTypeDefinitionProvider(language, {
				provideTypeDefinition: async (source, position, token) => {
					const document = documents.get(source.uri.toString());
					if (!document) return [];
					const result = await positionRequest(
						document.rpc,
						"editor.typeDefinition",
						document.cwd,
						source,
						position,
						token,
					);
					return token.isCancellationRequested ? [] : toMonacoDefinitions(monaco, result);
				},
			}),
			monaco.languages.registerReferenceProvider(language, {
				provideReferences: async (source, position, context, token) => {
					const document = documents.get(source.uri.toString());
					if (!document) return [];
					const result = await positionRequest(
						document.rpc,
						"editor.references",
						document.cwd,
						source,
						position,
						token,
						{ includeDeclaration: context.includeDeclaration },
					);
					return token.isCancellationRequested ? [] : toMonacoDefinitions(monaco, result);
				},
			}),
			monaco.languages.registerRenameProvider(language, {
				provideRenameEdits: async (source, position, newName, token) => {
					const document = documents.get(source.uri.toString());
					if (!document?.loadFile || !document.onBufferChange) return { edits: [] };
					const result = await positionRequest(
						document.rpc,
						"editor.rename",
						document.cwd,
						source,
						position,
						token,
						{ newName },
					);
					if (token.isCancellationRequested) return { edits: [] };
					const edit = toMonacoRenameEdit(monaco, result);
					return prepareMonacoRenameTargets(monaco, edit, document.loadFile, document.onBufferChange, token);
				},
			}),
		];
		registration = { count: 0, disposables };
		providerRegistrations.set(language, registration);
	}
	registration.count += 1;

	let epoch = 0;
	let timer: number | undefined;
	const syncDiagnostics = (): void => {
		if (model.isDisposed()) return;
		const requestEpoch = ++epoch;
		void rpc
			.request<{ available: boolean; diagnostics?: LspDiagnostic[] }>(
				"editor.sync",
				{ cwd, path: model.uri.fsPath, content: model.getValue() },
				{ timeoutMs: 12_000 },
			)
			.then(response => {
				if (requestEpoch !== epoch || model.isDisposed()) return;
				monaco.editor.setModelMarkers(
					model,
					MARKER_OWNER,
					response.available ? toMonacoMarkers(monaco, response.diagnostics ?? []) : [],
				);
			})
			.catch(() => {
				// Language support is optional. Keep the editor usable when the daemon
				// request fails; the next edit retries synchronization.
			});
	};
	const queueSync = (delay: number): void => {
		if (timer !== undefined) window.clearTimeout(timer);
		timer = window.setTimeout(syncDiagnostics, delay);
	};
	const changeListener = model.onDidChangeContent(() => queueSync(DIAGNOSTICS_DEBOUNCE_MS));
	queueSync(0);

	return {
		dispose: () => {
			epoch += 1;
			if (timer !== undefined) window.clearTimeout(timer);
			changeListener.dispose();
			if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
			if (documents.get(uri) === document) documents.delete(uri);
			const current = providerRegistrations.get(language);
			if (current) {
				current.count -= 1;
				if (current.count === 0) {
					for (const disposable of current.disposables) disposable.dispose();
					providerRegistrations.delete(language);
				}
			}
		},
	};
}
