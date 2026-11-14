import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
	createFileEditorModel,
	readFileEditorPosition,
	readFileEditorSelection,
} from "../src/components/FileCodeEditor";
import { disposeMonacoPeekModels } from "../src/lib/monaco-lsp";

const models = new Set<Monaco.editor.ITextModel>();

async function createModel(value: string): Promise<Monaco.editor.ITextModel> {
	const monaco = await import("monaco-editor");
	const model = createFileEditorModel(monaco, "/workspace/sample.txt", value);
	models.add(model);
	return model;
}

afterEach(() => {
	disposeMonacoPeekModels();
	for (const model of models) {
		if (!model.isDisposed()) model.dispose();
	}
	models.clear();
});

describe("FileCodeEditor model lifetime", () => {
	it("keeps Monaco's native undo stack for incremental edits", async () => {
		const monaco = await import("monaco-editor");
		const model = await createModel("before\r\n");
		model.pushEditOperations(null, [{ range: new monaco.Range(1, 1, 1, 1), text: "after\r\n" }], () => null);
		expect(model.getValue()).toBe("after\r\nbefore\r\n");
		await model.undo();
		expect(model.getValue()).toBe("before\r\n");
	});

	it("retains CRLF plus the final newline when seeding a document", async () => {
		const model = await createModel("first\r\nsecond\r\n");
		expect(model.getValue()).toBe("first\r\nsecond\r\n");
		expect(model.getOptions().insertSpaces).toBe(true);
		expect(model.getOptions().tabSize).toBe(2);
	});

	it("maps a model range to exact text, lines, language, and viewport coordinates", async () => {
		const monaco = await import("monaco-editor");
		const model = await createModel("first\nsecond\nthird");
		const selection = new monaco.Selection(2, 2, 3, 3);
		const editor = {
			getSelection: () => selection,
			getModel: () => model,
			getScrolledVisiblePosition: () => ({ left: 42, top: 20, height: 20 }),
		} as unknown as Monaco.editor.IStandaloneCodeEditor;
		const container = document.createElement("div");
		container.getBoundingClientRect = () => ({ left: 100, top: 200 }) as DOMRect;

		expect(readFileEditorSelection(editor, container, "/workspace/sample.txt")).toEqual({
			text: "econd\nth",
			path: "/workspace/sample.txt",
			language: "plaintext",
			startLine: 2,
			endLine: 3,
			x: 142,
			y: 220,
			height: 20,
		});
	});

	it("publishes the absolute path and one-based cursor for history restoration", async () => {
		const monaco = await import("monaco-editor");
		const editor = {
			getPosition: () => new monaco.Position(7, 9),
		} as Monaco.editor.IStandaloneCodeEditor;
		expect(readFileEditorPosition(editor, "D:/workspace/sample.ts")).toEqual({
			path: "D:/workspace/sample.ts",
			lineNumber: 7,
			column: 9,
		});
	});

	it("reuses a peek-loaded model instead of overwriting its draft with disk text", async () => {
		const monaco = await import("monaco-editor");
		const peekModel = monaco.editor.createModel(
			"unsaved peek draft",
			undefined,
			monaco.Uri.file("/workspace/sample.txt"),
		);
		models.add(peekModel);

		const model = createFileEditorModel(monaco, "/workspace/sample.txt", "stale disk text");
		expect(model).toBe(peekModel);
		expect(model.getValue()).toBe("unsaved peek draft");
	});
});
