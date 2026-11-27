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

it("paints the dictation preview into the editor without sending it", () => {
	const changes: string[] = [];
	const { host, editor } = harness({ value: "note: ", onChange: next => changes.push(next) });

	act(() => editor().setPreview("hel"));
	// The words are visible in the composer while they are still being said…
	expect(host.querySelector(".musepi-composer-editor__preview")?.textContent).toBe("hel");
	// …and the document — what actually gets sent — never sees them.
	expect(editor().value).toBe("note: ");
	expect(changes).toEqual([]);

	act(() => editor().setPreview("hello"));
	expect(host.querySelectorAll(".musepi-composer-editor__preview").length).toBe(1);
	expect(host.querySelector(".musepi-composer-editor__preview")?.textContent).toBe("hello");

	// Committing the segment retires the guess: no ghost text survives it.
	act(() => editor().setPreview(""));
	expect(host.querySelector(".musepi-composer-editor__preview")).toBeNull();
	expect(editor().value).toBe("note: ");
});

it("yields the placeholder to the preview so two sentences never share the box", () => {
	const { host, editor } = harness({ value: "", placeholder: "描述你想完成的任务" });
	// An empty composer with no dictation shows its hint.
	expect(host.querySelector(".musepi-composer-editor__placeholder")?.textContent).toBe("描述你想完成的任务");

	act(() => editor().setPreview("请自然说话"));
	// The document is still empty, but a preview now occupies the caret: drawing
	// the hint underneath it printed both sentences on top of each other.
	expect(host.querySelector(".musepi-composer-editor__placeholder")).toBeNull();
	expect(host.querySelector(".musepi-composer-editor__preview")?.textContent).toBe("请自然说话");

	act(() => editor().setPreview(""));
	// Cancelling the dictation gives the hint back.
	expect(host.querySelector(".musepi-composer-editor__placeholder")?.textContent).toBe("描述你想完成的任务");
});

it("brings the placeholder back after the preview was retired by a document edit", () => {
	const changes: string[] = [];
	const { host, editor } = harness({ value: "", placeholder: "hint", onChange: next => changes.push(next) });
	act(() => editor().setPreview("guess"));
	expect(host.querySelector(".musepi-composer-editor__placeholder")).toBeNull();
	// Typing retires the preview inside CodeMirror; the hint must be eligible
	// again, or an emptied composer would carry no hint at all.
	act(() => editor().replaceRange(0, 0, "x"));
	expect(editor().value).toBe("x");
	expect(changes).toEqual(["x"]);
});
