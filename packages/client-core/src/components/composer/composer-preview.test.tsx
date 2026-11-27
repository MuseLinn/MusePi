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

it("paints the dictation preview into the editor without sending it", () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	let handle: ComposerEditorHandle | null = null;
	const changes: string[] = [];
	act(() =>
		root.render(
			createElement(ComposerEditor, {
				ref: (value: ComposerEditorHandle | null) => {
					handle = value;
				},
				value: "note: ",
				onChange: (next: string) => changes.push(next),
			}),
		),
	);
	const editor = handle as ComposerEditorHandle | null;
	expect(editor).not.toBeNull();

	act(() => editor!.setPreview("hel"));
	// The words are visible in the composer while they are still being said…
	expect(host.querySelector(".musepi-composer-editor__preview")?.textContent).toBe("hel");
	// …and the document — what actually gets sent — never sees them.
	expect(editor!.value).toBe("note: ");
	expect(changes).toEqual([]);

	act(() => editor!.setPreview("hello"));
	expect(host.querySelectorAll(".musepi-composer-editor__preview").length).toBe(1);
	expect(host.querySelector(".musepi-composer-editor__preview")?.textContent).toBe("hello");

	// Committing the segment retires the guess: no ghost text survives it.
	act(() => editor!.setPreview(""));
	expect(host.querySelector(".musepi-composer-editor__preview")).toBeNull();
	expect(editor!.value).toBe("note: ");
});
