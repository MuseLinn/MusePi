import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ComposerEditor } from "./ComposerEditor";
import type { ComposerEditorHandle } from "./composer-editor-types";

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const mounted: { host: HTMLElement; root: ReturnType<typeof createRoot> }[] = [];
afterEach(() => {
	for (const { host, root } of mounted.splice(0)) {
		act(() => root.unmount());
		host.remove();
	}
});

function harness(props: { value: string; placeholder?: string; onChange?(next: string): void }) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	let handle: ComposerEditorHandle | null = null;
	act(() =>
		root.render(
			createElement(ComposerEditor, {
				ref: (value: ComposerEditorHandle | null) => {
					handle = value;
				},
				value: props.value,
				placeholder: props.placeholder,
				onChange: (value: string) => props.onChange?.(value),
			}),
		),
	);
	return { host, editor: () => handle as ComposerEditorHandle };
}

it("writes dictated words into the draft, marked as still provisional", () => {
	const changes: string[] = [];
	const { host, editor } = harness({ value: "note:  here", onChange: next => changes.push(next) });
	act(() => editor().setSelectionRange(6));
	act(() => editor().writeDictation("", "hel", true));
	// The words ARE the draft now (that is what makes them animatable and
	// sendable); a separate ghost would double them.
	expect(editor().value).toBe("note: hel here");
	expect(host.querySelector(".musepi-composer-editor__preview")).not.toBeNull();
	expect(changes.at(-1)).toBe("note: hel here");
	act(() => editor().cancelDictation());
	expect(editor().value).toBe("note:  here");
});

it("keeps the draft's tail when the caret sits mid-draft", () => {
	const { editor } = harness({ value: "before after", placeholder: "" });
	act(() => editor().setSelectionRange(7));
	act(() => editor().writeDictation("", "spoken", true));
	expect(editor().value).toBe("before spoken after");
	expect(editor().value.endsWith(" after")).toBe(true);
	// The caret ends just after the spoken block (its trailing separator
	// included), so the next phrase continues it instead of landing elsewhere.
	expect(editor().selectionStart).toBe("before spoken ".length);
});

it("keeps a continuous utterance in order when dictating mid-draft", () => {
	const { host, editor } = harness({ value: "note:  here", placeholder: "" });
	// The transcript writes through the editor, so the caret stays where the
	// user started speaking instead of the words landing at the draft's end.
	act(() => editor().setSelectionRange(6));
	act(() => editor().writeDictation("", "first phrase", true));
	expect(editor().value).toBe("note: first phrase here");
	// A commit moves the provisional text into `committed`; one region, no append.
	act(() => editor().writeDictation("first phrase ", "second phrase", false));
	// Spoken order preserved; the draft's tail is untouched.
	expect(editor().value).toBe("note: first phrase second phrase here");
	expect(editor().value.endsWith(" here")).toBe(true);
	// The dictated text IS the draft, painted as still-provisional.
	expect(host.querySelector(".musepi-composer-editor__preview")).not.toBeNull();
	// The caret sits after the dictated region, so the next phrase continues it.
	// "note: " + "first phrase " + "second phrase" — the caret ends the block;
	// the separator before "here" belongs after it.
	expect(editor().selectionStart).toBe("note: first phrase second phrase".length);
});

it("re-freezes instead of overwriting what the user typed after dictation", () => {
	const { editor } = harness({ value: "", placeholder: "" });
	act(() => editor().writeDictation("spoken", "", true));
	expect(editor().value).toBe("spoken");
	// The user edits the draft directly.
	act(() => editor().replaceRange(0, 0, "typed "));
	expect(editor().value).toBe("typed spoken");
	// The stale region must not be reused: the next write starts from the
	// document as it is now.
	act(() => editor().writeDictation("next", "", true));
	expect(editor().value).toContain("next");
	expect(editor().value).toContain("typed ");
});

it("takes its words back out when the dictation is discarded", () => {
	const { editor } = harness({ value: "before after", placeholder: "" });
	act(() => editor().setSelectionRange(7));
	act(() => editor().writeDictation("", "spoken words", true));
	expect(editor().value).toBe("before spoken words after");
	// Esc: the user withdrew it, so the draft returns to exactly what it was.
	act(() => editor().cancelDictation());
	expect(editor().value).toBe("before after");
	expect(editor().selectionStart).toBe(7);
});

it("writes only the characters that arrived, so the entrance effect is incremental", () => {
	const { editor } = harness({ value: "note:  here", placeholder: "" });
	act(() => editor().setSelectionRange(6));
	act(() => editor().writeDictation("", "第一", true));
	const before = editor().value.length;
	act(() => editor().writeDictation("", "第一句更长的内容", false));
	// A whole-document replacement would leave the same text but re-render every
	// character; only the delta may be inserted, so the per-character entrance
	// animates the new glyphs and leaves the rest still.
	expect(editor().value.length - before).toBe("句更长的内容".length);
	expect(editor().value).toBe("note: 第一句更长的内容 here");
});
