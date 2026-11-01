import "./happy-dom-shim";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type * as Monaco from "monaco-editor";
import { createFileEditorModel } from "../src/components/FileCodeEditor";
import {
	adoptMonacoPeekModel,
	disposeMonacoEditorOpener,
	disposeMonacoPeekModels,
	markMonacoPeekFileSaved,
	prepareMonacoDefinitionPeek,
	prepareMonacoReferencesPeek,
	registerMonacoLanguageFeatures,
	revealEditorLocation,
	toMonacoCompletionList,
	toMonacoDefinitions,
	toMonacoHover,
	toMonacoMarkers,
	toMonacoRenameEdit,
} from "../src/lib/monaco-lsp";
import type { RpcClient } from "../src/lib/rpc";

const models = new Set<Monaco.editor.ITextModel>();

afterEach(async () => {
	disposeMonacoEditorOpener();
	disposeMonacoPeekModels();
	vi.restoreAllMocks();
	for (const model of models) {
		if (!model.isDisposed()) model.dispose();
	}
	models.clear();
});

describe("Monaco LSP conversion", () => {
	it("retains a location requested before the Monaco runtime initializes", async () => {
		const monaco = await import("monaco-editor");
		const model = createFileEditorModel(monaco, "D:\\workspace\\early-location.ts", "first\nsecond\nthird");
		models.add(model);
		const positions: Monaco.Position[] = [];
		const revealedPositions: Monaco.Position[] = [];
		const editor = {
			getModel: () => model,
			setPosition: (position: Monaco.Position) => positions.push(position),
			revealPositionInCenter: (position: Monaco.Position) => revealedPositions.push(position),
		} as Monaco.editor.IStandaloneCodeEditor;
		const rpc = { request: async () => ({ available: false }) } as unknown as RpcClient;
		revealEditorLocation({ path: "D:\\workspace\\early-location.ts", lineNumber: 3, column: 1 });
		const registration = registerMonacoLanguageFeatures(monaco, rpc, "/workspace", editor, () => {});
		try {
			expect(positions).toHaveLength(1);
			expect(positions[0]).toMatchObject({ lineNumber: 3, column: 1 });
			expect(revealedPositions).toHaveLength(1);
			expect(revealedPositions[0]).toMatchObject({ lineNumber: 3, column: 1 });
		} finally {
			registration.dispose();
		}
	});

	it("converts zero-based diagnostics to one-based Monaco markers", async () => {
		const monaco = await import("monaco-editor");
		const markers = toMonacoMarkers(monaco, [
			{
				range: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } },
				severity: 2,
				source: "typescript",
				message: "warning",
			},
		]);
		expect(markers).toEqual([
			{
				startLineNumber: 2,
				startColumn: 3,
				endLineNumber: 2,
				endColumn: 7,
				severity: monaco.MarkerSeverity.Warning,
				source: "typescript",
				message: "warning",
				code: undefined,
			},
		]);
	});

	it("maps text edits and drops snippet completions when snippets are disabled", async () => {
		const monaco = await import("monaco-editor");
		const model = createFileEditorModel(monaco, "/workspace/a.ts", "const value = al");
		models.add(model);
		const position = new monaco.Position(1, 17);
		const result = toMonacoCompletionList(
			monaco,
			{
				isIncomplete: false,
				items: [
					{
						label: "alpha",
						kind: 6,
						textEdit: {
							range: { start: { line: 0, character: 14 }, end: { line: 0, character: 16 } },
							newText: "alpha",
						},
					},
					{ label: "snippet", insertText: "call($0)", insertTextFormat: 2 },
				],
			},
			model,
			position,
		);
		expect(result.incomplete).toBe(false);
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0]).toMatchObject({
			label: "alpha",
			kind: monaco.languages.CompletionItemKind.Variable,
			insertText: "alpha",
			range: { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 17 },
		});
		expect(result.suggestions[0]?.insertTextRules).toBeUndefined();
	});

	it("converts hover markup and definition links without losing their ranges", async () => {
		const monaco = await import("monaco-editor");
		const hover = toMonacoHover({
			contents: [{ language: "typescript", value: "const alpha: number" }],
			range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
		});
		expect(hover?.contents[0]?.value).toContain("```typescript");
		expect(hover?.range).toEqual({ startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 12 });

		const definitions = toMonacoDefinitions(monaco, [
			{
				targetUri: "file:///workspace/definitions.ts",
				targetRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } },
				targetSelectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 11 } },
			},
		]);
		expect(definitions[0]?.uri.toString()).toBe("file:///workspace/definitions.ts");
		expect(definitions[0]?.range.startLineNumber).toBe(4);
		expect(definitions[0]?.range.startColumn).toBe(7);
	});

	it("records same-file and cross-file definition positions and reveals their targets", async () => {
		const monaco = await import("monaco-editor");
		const openers: Monaco.editor.ICodeEditorOpener[] = [];
		vi.spyOn(monaco.editor, "registerEditorOpener").mockImplementation(opener => {
			openers.push(opener);
			return { dispose: () => {} };
		});
		const rpc = { request: async () => ({ available: false }) } as unknown as RpcClient;
		const sourceModel = createFileEditorModel(monaco, "/workspace/a.ts", "const value = alpha;");
		const targetModel = createFileEditorModel(monaco, "/workspace/definitions.ts", "const alpha = 1;");
		models.add(sourceModel);
		models.add(targetModel);
		const sourcePositions: Monaco.Position[] = [];
		const source = {
			getModel: () => sourceModel,
			getPosition: () => new monaco.Position(2, 3),
			setPosition: (position: Monaco.Position) => sourcePositions.push(position),
			revealPositionInCenter: () => {},
			focus: () => {},
		} as unknown as Monaco.editor.IStandaloneCodeEditor;
		const openedPaths: string[] = [];
		const navigations: Array<{ source: unknown; target: unknown }> = [];
		const targetPositions: Monaco.Position[] = [];
		const revealedPositions: Monaco.Position[] = [];
		const target = {
			getModel: () => targetModel,
			setPosition: (position: Monaco.Position) => targetPositions.push(position),
			revealPositionInCenter: (position: Monaco.Position) => revealedPositions.push(position),
			focus: () => {},
		} as Monaco.editor.IStandaloneCodeEditor;
		const sourceRegistration = registerMonacoLanguageFeatures(monaco, rpc, "/workspace", source, (from, to) => {
			navigations.push({ source: from, target: to });
			openedPaths.push(to.path);
		});

		expect(openers[0]?.openCodeEditor(source, sourceModel.uri, { lineNumber: 5, column: 2 })).toBe(true);
		expect(navigations[0]).toEqual({
			source: { path: sourceModel.uri.fsPath, lineNumber: 2, column: 3 },
			target: { path: sourceModel.uri.fsPath, lineNumber: 5, column: 2 },
		});
		expect(openedPaths).toEqual([sourceModel.uri.fsPath]);
		expect(sourcePositions).toEqual([new monaco.Position(5, 2)]);

		const targetResource = monaco.Uri.file("/workspace/definitions.ts");
		expect(openers[0]?.openCodeEditor(source, targetResource, { lineNumber: 4, column: 7 })).toBe(true);
		expect(navigations[1]).toEqual({
			source: { path: sourceModel.uri.fsPath, lineNumber: 2, column: 3 },
			target: { path: targetResource.fsPath, lineNumber: 4, column: 7 },
		});
		expect(openedPaths).toEqual([sourceModel.uri.fsPath, targetResource.fsPath]);

		const targetRegistration = registerMonacoLanguageFeatures(monaco, rpc, "/workspace", target, (from, to) => {
			navigations.push({ source: from, target: to });
		});
		expect(targetPositions).toEqual([new monaco.Position(4, 7)]);
		expect(revealedPositions).toEqual([new monaco.Position(4, 7)]);

		expect(openers[0]?.openCodeEditor(source, targetResource, { lineNumber: 2, column: 3 })).toBe(true);
		expect(openedPaths).toEqual([sourceModel.uri.fsPath, targetResource.fsPath, targetResource.fsPath]);
		expect(targetPositions[1]).toEqual(new monaco.Position(2, 3));
		expect(revealedPositions[1]).toEqual(new monaco.Position(2, 3));
		targetRegistration.dispose();
		sourceRegistration.dispose();
	});

	it.each([
		["registerImplementationProvider", "provideImplementation", "editor.implementation"],
		["registerTypeDefinitionProvider", "provideTypeDefinition", "editor.typeDefinition"],
	] as const)(
		"routes %s through the daemon and converts returned locations",
		async (registration, method, rpcMethod) => {
			const monaco = await import("monaco-editor");
			const sourceModel = createFileEditorModel(monaco, "/workspace/navigation-source.ts", "alpha;");
			models.add(sourceModel);
			let provider: Monaco.languages.ImplementationProvider | Monaco.languages.TypeDefinitionProvider | undefined;
			vi.spyOn(monaco.languages, registration).mockImplementation((_language, candidate) => {
				provider = candidate;
				return { dispose: () => {} };
			});
			const requests: Array<{ method: string; params: unknown }> = [];
			const rpc = {
				request: async (requestMethod: string, params: unknown) => {
					requests.push({ method: requestMethod, params });
					return {
						available: true,
						result: [
							{
								uri: "file:///workspace/navigation-target.ts",
								range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
							},
						],
					};
				},
			} as unknown as RpcClient;
			const editor = { getModel: () => sourceModel } as Monaco.editor.IStandaloneCodeEditor;
			const features = registerMonacoLanguageFeatures(monaco, rpc, "/workspace", editor, () => {});
			if (!provider) throw new Error(`${registration} was not registered`);
			const token: Monaco.CancellationToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} }),
			};
			const result = await provider[method](sourceModel, new monaco.Position(3, 5), token);
			expect(requests.find(request => request.method === rpcMethod)?.params).toMatchObject({
				path: sourceModel.uri.fsPath,
				content: "alpha;",
				line: 2,
				character: 4,
			});
			const locations = Array.isArray(result) ? result : [result];
			expect(locations[0]).toMatchObject({
				range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 10 },
			});
			features.dispose();
		},
	);

	it("loads an unopened definition and preserves its draft through save and adoption", async () => {
		const monaco = await import("monaco-editor");
		const sourceModel = createFileEditorModel(monaco, "/workspace/source.ts", "alpha;");
		models.add(sourceModel);
		const targetUri = monaco.Uri.file("/workspace/target.ts");
		const rpc = {
			request: async () => ({
				available: true,
				result: [
					{
						uri: targetUri.toString(),
						range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
					},
				],
			}),
		} as unknown as RpcClient;
		const editor = {
			getModel: () => sourceModel,
			getPosition: () => new monaco.Position(1, 1),
		} as Monaco.editor.IStandaloneCodeEditor;
		const loadedPaths: string[] = [];
		const changes: Array<{ path: string; text: string; saved: string }> = [];

		await prepareMonacoDefinitionPeek(
			monaco,
			rpc,
			"/workspace",
			editor,
			async path => {
				loadedPaths.push(path);
				return { path, text: "const alpha = 1;", saved: "const alpha = 1;" };
			},
			buffer => changes.push(buffer),
		);

		const target = monaco.editor.getModel(targetUri);
		if (!target) throw new Error("Definition target was not loaded");
		expect(loadedPaths).toEqual([targetUri.fsPath]);
		expect(target.getValue()).toBe("const alpha = 1;");
		target.setValue("draft");
		target.setValue("draft\nlater");
		markMonacoPeekFileSaved(monaco, targetUri.fsPath, "draft");
		expect(changes.at(-1)).toEqual({ path: targetUri.fsPath, text: "draft\nlater", saved: "draft" });

		models.add(target);
		adoptMonacoPeekModel(monaco, targetUri.fsPath);
		disposeMonacoPeekModels();
		expect(target.isDisposed()).toBe(false);
		expect(target.getValue()).toBe("draft\nlater");
	});

	it("loads an unopened reference and includes declarations for native peek", async () => {
		const monaco = await import("monaco-editor");
		const sourceModel = createFileEditorModel(monaco, "/workspace/source.ts", "alpha;");
		models.add(sourceModel);
		const targetUri = monaco.Uri.file("/workspace/reference.ts");
		const requests: Array<{ method: string; params: unknown }> = [];
		const rpc = {
			request: async (method: string, params: unknown) => {
				requests.push({ method, params });
				return {
					available: true,
					result: [
						{
							uri: targetUri.toString(),
							range: { start: { line: 1, character: 15 }, end: { line: 1, character: 20 } },
						},
					],
				};
			},
		} as unknown as RpcClient;
		const editor = {
			getModel: () => sourceModel,
			getPosition: () => new monaco.Position(1, 1),
		} as Monaco.editor.IStandaloneCodeEditor;
		const loadedPaths: string[] = [];

		await prepareMonacoReferencesPeek(
			monaco,
			rpc,
			"/workspace",
			editor,
			async path => {
				loadedPaths.push(path);
				return { path, text: "const second = alpha;", saved: "const second = alpha;" };
			},
			() => {},
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("editor.references");
		expect(requests[0]?.params).toMatchObject({ includeDeclaration: true });
		expect(loadedPaths).toEqual([targetUri.fsPath]);
		expect(monaco.editor.getModel(targetUri)?.getValue()).toBe("const second = alpha;");
	});

	it("converts both WorkspaceEdit shapes and rejects resource operations atomically", async () => {
		const monaco = await import("monaco-editor");
		const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } };
		const converted = toMonacoRenameEdit(monaco, {
			changes: { "file:///workspace/source.ts": [{ range, newText: "beta" }] },
			documentChanges: [
				{
					textDocument: { uri: "file:///workspace/target.ts", version: null },
					edits: [{ range, newText: "beta" }],
				},
			],
		});
		expect(converted.rejectReason).toBeUndefined();
		expect(converted.edits).toHaveLength(2);
		expect(converted.edits[0]).toMatchObject({
			resource: monaco.Uri.file("/workspace/source.ts"),
			textEdit: { range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 12 }, text: "beta" },
			versionId: undefined,
		});

		const rejected = toMonacoRenameEdit(monaco, {
			changes: { "file:///workspace/source.ts": [{ range, newText: "beta" }] },
			documentChanges: [{ kind: "rename", oldUri: "file:///workspace/old.ts", newUri: "file:///workspace/new.ts" }],
		});
		expect(rejected.edits).toEqual([]);
		expect(rejected.rejectReason).toContain("resource operations");
	});

	it("preloads an unopened rename target and publishes its dirty draft", async () => {
		const monaco = await import("monaco-editor");
		const sourceModel = createFileEditorModel(monaco, "/workspace/rename-source.ts", "const alpha = 1;");
		models.add(sourceModel);
		const targetUri = monaco.Uri.file("/workspace/rename-target.ts");
		let provider: Monaco.languages.RenameProvider | undefined;
		vi.spyOn(monaco.languages, "registerRenameProvider").mockImplementation((_language, candidate) => {
			provider = candidate;
			return { dispose: () => {} };
		});
		const requests: Array<{ method: string; params: unknown }> = [];
		const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } };
		const rpc = {
			request: async (method: string, params: unknown) => {
				requests.push({ method, params });
				return {
					available: true,
					result: {
						changes: { [sourceModel.uri.toString()]: [{ range, newText: "beta" }] },
						documentChanges: [
							{
								textDocument: { uri: targetUri.toString(), version: null },
								edits: [{ range, newText: "beta" }],
							},
						],
					},
				};
			},
		} as unknown as RpcClient;
		const editor = { getModel: () => sourceModel } as Monaco.editor.IStandaloneCodeEditor;
		const loadedPaths: string[] = [];
		const changes: Array<{ path: string; text: string; saved: string }> = [];
		const registration = registerMonacoLanguageFeatures(
			monaco,
			rpc,
			"/workspace",
			editor,
			() => {},
			async path => {
				loadedPaths.push(path);
				return { path, text: "const alpha = 2;", saved: "const alpha = 2;" };
			},
			buffer => changes.push(buffer),
		);
		if (!provider) throw new Error("Rename provider was not registered");
		const token: Monaco.CancellationToken = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} }),
		};
		const edit = await provider.provideRenameEdits(sourceModel, new monaco.Position(1, 7), "beta", token);
		if (!edit) throw new Error("Rename provider returned no edit");
		expect(edit.rejectReason).toBeUndefined();
		expect(edit.edits).toHaveLength(2);
		expect(requests.find(request => request.method === "editor.rename")?.params).toMatchObject({ newName: "beta" });
		expect(loadedPaths).toEqual([targetUri.fsPath]);
		const target = monaco.editor.getModel(targetUri);
		if (!target) throw new Error("Rename target was not loaded");
		models.add(target);
		target.pushEditOperations(null, [{ range: new monaco.Range(1, 7, 1, 12), text: "beta" }], () => null);
		expect(target.getValue()).toBe("const beta = 2;");
		expect(changes.at(-1)).toEqual({ path: targetUri.fsPath, text: "const beta = 2;", saved: "const alpha = 2;" });
		registration.dispose();
	});
});
