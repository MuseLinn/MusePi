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

function harness(initial: string) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	let handle: ComposerEditorHandle | null = null;
	const changes: string[] = [];
	const render = (value: string) =>
		act(() =>
			root.render(
				createElement(ComposerEditor, {
					ref: (next: ComposerEditorHandle | null) => {
						handle = next;
					},
					value,
					placeholder: "",
					onChange: (next: string) => changes.push(next),
				}),
			),
		);
	render(initial);
	return { host, render, changes, editor: () => handle as ComposerEditorHandle };
}

/** A stale range must never reach CodeMirror: it throws
 *  "Invalid change range N to M (in doc of length L)", which escaped the
 *  composer as a render error and blanked the whole window. */
it("does not throw when the document shrank under a frozen dictation region", () => {
	const { editor } = harness("hello world");
	act(() => editor().setSelectionRange(11));
	act(() => editor().writeDictation("", "spoken", true));
	expect(() => {
		// The user selects everything and replaces it: the region's offsets are
		// now past the end of a much shorter document.
		act(() => editor().replaceRange(0, editor().value.length, "hi"));
		act(() => editor().writeDictation("spoken more", "", false));
	}).not.toThrow();
	// Whatever it decides, the draft must still hold the user's text.
	expect(editor().value).toContain("hi");
});

it("stops writing once the region no longer matches the document", () => {
	const { editor } = harness("abc");
	act(() => editor().setSelectionRange(3));
	act(() => editor().writeDictation("", "one", true));
	expect(editor().value).toBe("abcone");
	// Simulate an out-of-band value write (draft restore, session switch) that
	// the editor never saw as an edit of its own region.
	act(() => editor().replaceRange(0, editor().value.length, "replaced"));
	// The next hypothesis must NOT be spliced into a document it does not
	// describe; leaving the draft alone beats corrupting it.
	act(() => editor().writeDictation("one", " two", false));
	expect(editor().value).toBe("replaced");
});

/** The reported crash: a stale region offset handed to CodeMirror throws
 *  "Invalid change range 4 to 9 (in doc of length 5)", which blanks the window. */
it("survives a document replaced under an in-flight hypothesis", () => {
	const { editor } = harness("好像不对 draft");
	act(() => editor().setSelectionRange(editor().value.length));
	act(() => editor().writeDictation("", "第一句", true));
	// The draft is replaced wholesale while the stream keeps decoding — the
	// exact shape of the reported error (range past the new document's end).
	act(() => editor().replaceRange(0, editor().value.length, "好像不对。"));
	expect(() =>
		act(() => {
			editor().writeDictation("第一句", "第二句", false);
		}),
	).not.toThrow();
	// The user's replacement must survive; a bad range may never corrupt it.
	expect(editor().value).toBe("好像不对。");
});

it("retires the provisional paint when the dictation finishes", () => {
	const { host, editor } = harness("hello ");
	act(() => editor().setSelectionRange(6));
	act(() => editor().writeDictation("", "spoken words", true));
	// While dictating the words are painted as provisional.
	expect(host.querySelector(".musepi-composer-editor__preview")).not.toBeNull();
	act(() => editor().commitDictation());
	// After it ends they are ordinary draft text: no region left behind, or the
	// text would look like a guess forever and re-arm as a splice target.
	expect(host.querySelector(".musepi-composer-editor__preview")).toBeNull();
	expect(editor().value).toBe("hello spoken words");
});

/** Reported: "连续点击输入了几次突然出现这种情况" — repeated start/stop cycles
 *  left a region from one cycle alive into the next. */
it("survives repeated dictation cycles on a document that keeps changing", () => {
	const { editor } = harness("");
	const run = (text: string) => {
		act(() => editor().setSelectionRange(editor().value.length));
		act(() => editor().writeDictation("", text, true));
		act(() => editor().writeDictation(text, "", false));
		act(() => editor().commitDictation());
	};
	expect(() => {
		run("第一次");
		run("第二次");
		act(() => editor().replaceRange(0, editor().value.length, "短"));
		// A late hypothesis from the previous cycle must not throw here.
		act(() => editor().writeDictation("第二次", "迟到", false));
	}).not.toThrow();
	expect(editor().value).toContain("短");
});
