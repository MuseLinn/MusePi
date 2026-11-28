import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dictationField, dictationWrite, marksField, setDictationRange } from "./composer-editor-code";
import type { EditorMark } from "./composer-editor-types";

afterAll(() => {
	void GlobalRegistrator.unregister();
});

let view: EditorView | null = null;
afterEach(() => {
	view?.destroy();
	view = null;
});

/** Mount a bare editor with the dictation range field installed. */
function mountDictation(doc: string, start: number, end: number): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	view = new EditorView({
		state: EditorState.create({ doc, extensions: [dictationField] }),
		parent,
	});
	view.dispatch({ selection: { anchor: start, head: end } });
	return view;
}

function mount(doc: string, marks: readonly EditorMark[]): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	view = new EditorView({
		state: EditorState.create({ doc, extensions: [marksField({ current: marks })] }),
		parent,
	});
	return view;
}

describe("marksField — reference chips", () => {
	it("renders a path reference as a chip, not as its raw token", () => {
		const doc = "@src/app.ts and the rest";
		const v = mount(doc, [
			{
				from: 0,
				to: "@src/app.ts".length,
				className: "gui-ta-ref",
				revealAs: { label: "app.ts", kind: "file" },
			},
		]);
		const chip = v.dom.querySelector(".gui-ta-ref");
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toBe("app.ts");
		expect(chip!.classList.contains("gui-ta-ref--file")).toBe(true);
		// A reference is not a mention: carrying that class would also apply its
		// ::before glyph box, which the chip draws for itself.
		expect(chip!.classList.contains("gui-ta-hl-mention")).toBe(false);
		// The document itself is untouched: the send path still sees the token.
		expect(v.state.doc.toString()).toBe(doc);
		// The raw characters are not painted as visible text alongside the chip.
		expect(v.dom.textContent).not.toContain("@src/app.ts");
	});

	it("marks a session reference with the session class", () => {
		const raw = "@history://abc123";
		const v = mount(raw, [
			{ from: 0, to: raw.length, className: "gui-ta-ref", revealAs: { label: "abc123", kind: "session" } },
		]);
		expect(v.dom.querySelector(".gui-ta-ref--session")?.textContent).toBe("abc123");
	});

	it("leaves a plain mention painted as text", () => {
		const v = mount("@图片1", [
			{
				from: 0,
				to: "@图片1".length,
				className: "gui-ta-hl-mention gui-ta-hl-mention--image",
				mentionName: "图片1",
			},
		]);
		expect(v.dom.querySelector(".gui-ta-ref")).toBeNull();
		// The sigil is hidden, the label painted.
		expect(v.dom.textContent).toContain("图片1");
		expect(v.dom.querySelector(".gui-ta-hl-mention")).not.toBeNull();
	});
});

describe("dictationField — the dictated range", () => {
	it("paints the dictated range as provisional text without changing the document", () => {
		const v = mountDictation("note:  here", 6, 6);
		v.dispatch({ effects: setDictationRange.of({ from: 6, to: 12 }) });
		expect(v.state.doc.toString()).toBe("note:  here");
		expect(v.dom.querySelector(".musepi-composer-editor__preview")).not.toBeNull();
	});

	it("keeps the range across the dictation's own write and drops it on a user edit", () => {
		const v = mountDictation("a b", 2, 2);
		v.dispatch({ effects: setDictationRange.of({ from: 2, to: 2 }) });
		// Our own edit: the range maps across it and stays decorated.
		v.dispatch({
			changes: { from: 2, to: 2, insert: "spoken" },
			annotations: dictationWrite.of(true),
		});
		expect(v.state.field(dictationField)?.to).toBe(8);
		// A user edit clears it: their words are not a guess any more.
		v.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
		expect(v.state.field(dictationField)).toBeNull();
	});
});
