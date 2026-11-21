import "../../../test/happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import type { ComposerEditorHandle } from "@musepi/client-core/src/components/composer/composer-editor-types";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { addFileToChat, addToChatUnavailableReason, registerAddToChatFiles } from "./add-to-chat";
import { useComposerIntake } from "./use-composer-intake";

/**
 * The composer side of "Add to chat": the intake publishes the draft
 * capability the file menu calls. These tests drive the real bridge against
 * the real hook — the file menu's own tests stand in a fake draft, so this
 * file owns the editor contract (insertion after the selection, retained
 * selection, focus, nothing sent).
 */

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let dom: HTMLDivElement | null = null;
const originalRaf = globalThis.requestAnimationFrame;

/** Deterministic focus/selection timing: the hook defers them one frame. */
function synchronousRaf(): void {
	globalThis.requestAnimationFrame = cb => {
		cb(0);
		return 0;
	};
}

afterEach(() => {
	act(() => root?.unmount());
	globalThis.requestAnimationFrame = originalRaf;
	host?.remove();
	dom?.remove();
	document.body.innerHTML = "";
	root = null;
	host = null;
	dom = null;
});

interface FakeEditor {
	handle: ComposerEditorHandle;
	value: { current: string };
	selection: { current: { start: number; end: number } };
	focusCount: { current: number };
	autosizeCount: { current: number };
}

function fakeEditor(initial: { value: string; start: number; end?: number; editable?: boolean }): FakeEditor {
	dom = document.createElement("div");
	dom.dataset.editable = initial.editable === false ? "0" : "1";
	// happy-dom lays nothing out; a visible composer has real client rects.
	dom.getClientRects = () =>
		[{ x: 0, y: 0, width: 320, height: 24, top: 0, left: 0, right: 320, bottom: 24 }] as unknown as DOMRectList;
	document.body.append(dom);

	const value = { current: initial.value };
	const selection = { current: { start: initial.start, end: initial.end ?? initial.start } };
	const focusCount = { current: 0 };
	const autosizeCount = { current: 0 };
	const handle: ComposerEditorHandle = {
		get value() {
			return value.current;
		},
		get selectionStart() {
			return selection.current.start;
		},
		get selectionEnd() {
			return selection.current.end;
		},
		dom,
		setSelectionRange: (start, end = start) => {
			selection.current = { start, end };
		},
		focus: () => {
			focusCount.current += 1;
		},
		blur: () => {},
		insertText: () => {},
		replaceRange: () => {},
		autosize: () => {},
		setFocused: () => {},
	};
	return { handle, value, selection, focusCount, autosizeCount };
}

/** Mounts the intake the composers hand to `ComposerEditor`; the text state it
 *  writes is the draft, and `editor.value` follows it like the real editor. */
function mountDraft(editor: FakeEditor): { drafts: string[] } {
	const drafts: string[] = [];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	function Probe(): null {
		const ref = useRef<ComposerEditorHandle | null>(editor.handle);
		useComposerIntake({
			editor: ref,
			attachments: [],
			addFiles: async () => [],
			setAttachments: () => {},
			setText: next => {
				drafts.push(next);
				editor.value.current = next;
			},
			clearAllRef: { current: false },
			autosize: () => {
				editor.autosizeCount.current += 1;
			},
		});
		return null;
	}
	act(() => root?.render(<Probe />));
	return { drafts };
}

async function addThroughMenu(): Promise<void> {
	await act(async () => {
		await addFileToChat({ path: "/work/a.md", name: "a.md", size: 3, isDir: false });
	});
}

describe("composer draft capability", () => {
	test("adds the reference after a collapsed caret and returns focus", async () => {
		synchronousRaf();
		const editor = fakeEditor({ value: "hi", start: 2 });
		const { drafts } = mountDraft(editor);
		// Before the file intake exists the menu has no half to work with.
		expect(addToChatUnavailableReason()).not.toBeNull();
		registerAddToChatFiles({ addWorkspaceFile: async () => "文件1" });
		expect(addToChatUnavailableReason()).toBeNull();

		await addThroughMenu();
		expect(drafts).toEqual(["hi @文件1 "]);
		expect(editor.value.current).toBe("hi @文件1 ");
		expect(editor.selection.current).toEqual({ start: 2, end: 2 });
		expect(editor.focusCount.current).toBe(1);
		expect(editor.autosizeCount.current).toBe(1);
	});

	test("keeps the selected text and restores that range after inserting", async () => {
		synchronousRaf();
		const editor = fakeEditor({ value: "keep me", start: 0, end: 7 });
		const { drafts } = mountDraft(editor);
		registerAddToChatFiles({ addWorkspaceFile: async () => "文件1" });

		await addThroughMenu();
		expect(drafts).toEqual(["keep me @文件1 "]);
		expect(editor.value.current.slice(0, 7)).toBe("keep me");
		expect(editor.selection.current).toEqual({ start: 0, end: 7 });
		expect(editor.focusCount.current).toBe(1);
	});

	test("an editor that is not editable refuses the insertion", async () => {
		synchronousRaf();
		const editor = fakeEditor({ value: "hi", start: 2, editable: false });
		mountDraft(editor);
		registerAddToChatFiles({ addWorkspaceFile: async () => "文件1" });
		expect(addToChatUnavailableReason()).not.toBeNull();
		await addThroughMenu();
		expect(editor.value.current).toBe("hi");
		expect(editor.focusCount.current).toBe(0);
	});

	test("an editor that left the document refuses the insertion", async () => {
		synchronousRaf();
		const editor = fakeEditor({ value: "hi", start: 2 });
		mountDraft(editor);
		registerAddToChatFiles({ addWorkspaceFile: async () => "文件1" });
		expect(addToChatUnavailableReason()).toBeNull();
		dom?.remove();
		expect(addToChatUnavailableReason()).not.toBeNull();
		await addThroughMenu();
		expect(editor.value.current).toBe("hi");
	});
});
