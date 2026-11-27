import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { marksField, previewField, setPreview } from "./composer-editor-code";
import type { EditorMark } from "./composer-editor-types";

afterAll(() => {
	void GlobalRegistrator.unregister();
});

let view: EditorView | null = null;
afterEach(() => {
	view?.destroy();
	view = null;
});

/** Mount an editor whose preview is already painted. */
function mountTail(doc: string, preview: string): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	view = new EditorView({
		state: EditorState.create({ doc, extensions: [previewField] }),
		parent,
	});
	view.dispatch({ effects: setPreview.of(preview) });
	return view;
}

function tail(v: EditorView): string {
	return v.dom.querySelector(".musepi-composer-editor__preview")?.textContent ?? "";
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

describe("previewField — volatile dictation preview", () => {
	it("paints the preview without writing it into the document", () => {
		const v = mountTail("note: ", "hel");
		expect(v.state.doc.toString()).toBe("note: ");
		expect(v.dom.querySelector(".musepi-composer-editor__preview")?.textContent).toBe("hel");
	});

	it("replaces the preview in place instead of appending", () => {
		const v = mountTail("", "hel");
		expect(tail(v)).toBe("hel");
		v.dispatch({ effects: setPreview.of("hello wor") });
		expect(tail(v)).toBe("hello wor");
		// One widget, not a growing pile of guesses.
		expect(v.dom.querySelectorAll(".musepi-composer-editor__preview").length).toBe(1);
	});

	it("drops the preview when the document changes", () => {
		const v = mountTail("", "guess");
		expect(tail(v)).toBe("guess");
		// Committing the segment (an external value write) must retire the guess.
		v.dispatch({ changes: { from: 0, to: 0, insert: "committed" } });
		expect(tail(v)).toBe("");
		expect(v.state.doc.toString()).toBe("committed");
	});

	it("clears the preview on an explicit empty effect", () => {
		const v = mountTail("", "guess");
		v.dispatch({ effects: setPreview.of("") });
		expect(tail(v)).toBe("");
	});
});
