import "../../../test/happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import type { ComposerEditorHandle } from "@musepi/client-core/src/components/composer/composer-editor-types";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type AddToChatKey, addFileToChat, addToChatUnavailableReason, registerAddToChatFiles } from "./add-to-chat";
import { useComposerIntake } from "./use-composer-intake";

/**
 * The composer side of "Add to chat": the intake publishes the draft
 * capability the file menu calls. These tests drive the real bridge against
 * the real hook — the file menu's own tests stand in a fake draft, so this
 * file owns the editor contract (insertion after the selection, retained
 * selection, focus, nothing sent) and the several-composers resolution.
 */

let mounted: { root: Root; host: HTMLDivElement }[] = [];
let editorDoms: HTMLDivElement[] = [];
let dom: HTMLDivElement | null = null;
let disposers: (() => void)[] = [];
const originalRaf = globalThis.requestAnimationFrame;

/** Deterministic focus/selection timing: the hook defers them one frame. */
function synchronousRaf(): void {
	globalThis.requestAnimationFrame = cb => {
		cb(0);
		return 0;
	};
}

afterEach(() => {
	for (const entry of mounted.reverse()) act(() => entry.root.unmount());
	for (const dispose of disposers.reverse()) dispose();
	for (const editorDom of editorDoms) editorDom.remove();
	globalThis.requestAnimationFrame = originalRaf;
	document.body.innerHTML = "";
	mounted = [];
	editorDoms = [];
	disposers = [];
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
	const editorDom = document.createElement("div");
	editorDom.tabIndex = 0;
	editorDom.dataset.editable = initial.editable === false ? "0" : "1";
	// happy-dom lays nothing out; a visible composer has real client rects.
	editorDom.getClientRects = () =>
		[{ x: 0, y: 0, width: 320, height: 24, top: 0, left: 0, right: 320, bottom: 24 }] as unknown as DOMRectList;
	document.body.append(editorDom);
	editorDoms.push(editorDom);
	dom = editorDom;

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
		dom: editorDom,
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
		setPreview: () => {},
		setFocused: () => {},
	};
	return { handle, value, selection, focusCount, autosizeCount };
}

/** Mounts the intake the composers hand to `ComposerEditor`; the text state it
 *  writes is the draft, and `editor.value` follows it like the real editor.
 *  `key` is the mount's own attachment setter — the identity the bridge pairs
 *  both halves by. */
function mountDraft(editor: FakeEditor): { drafts: string[]; key: AddToChatKey; unmount(): void } {
	const drafts: string[] = [];
	const key = () => {};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Probe(): null {
		const ref = useRef<ComposerEditorHandle | null>(editor.handle);
		useComposerIntake({
			editor: ref,
			attachments: [],
			addFiles: async () => [],
			setAttachments: key,
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
	act(() => root.render(<Probe />));
	const entry = { root, host };
	mounted.push(entry);
	return {
		drafts,
		key,
		unmount: () => {
			act(() => root.unmount());
			host.remove();
			mounted = mounted.filter(item => item !== entry);
		},
	};
}

function registerFiles(key: AddToChatKey, label = "文件1"): void {
	disposers.push(registerAddToChatFiles(key, { addWorkspaceFile: async () => label }));
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
		const { drafts, key } = mountDraft(editor);
		// Before the file intake exists the menu has no half to work with.
		expect(addToChatUnavailableReason()).not.toBeNull();
		registerFiles(key);
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
		const { drafts, key } = mountDraft(editor);
		registerFiles(key);

		await addThroughMenu();
		expect(drafts).toEqual(["keep me @文件1 "]);
		expect(editor.value.current.slice(0, 7)).toBe("keep me");
		expect(editor.selection.current).toEqual({ start: 0, end: 7 });
		expect(editor.focusCount.current).toBe(1);
	});

	test("an editor that is not editable refuses the insertion", async () => {
		synchronousRaf();
		const editor = fakeEditor({ value: "hi", start: 2, editable: false });
		registerFiles(mountDraft(editor).key);
		expect(addToChatUnavailableReason()).not.toBeNull();
		await addThroughMenu();
		expect(editor.value.current).toBe("hi");
		expect(editor.focusCount.current).toBe(0);
	});

	test("an editor that left the document refuses the insertion", async () => {
		synchronousRaf();
		const editor = fakeEditor({ value: "hi", start: 2 });
		registerFiles(mountDraft(editor).key);
		expect(addToChatUnavailableReason()).toBeNull();
		dom?.remove();
		expect(addToChatUnavailableReason()).not.toBeNull();
		await addThroughMenu();
		expect(editor.value.current).toBe("hi");
	});
});

describe("several live composers", () => {
	test("the composer whose editor holds focus takes the insertion", async () => {
		synchronousRaf();
		const main = fakeEditor({ value: "main", start: 4 });
		const side = fakeEditor({ value: "side", start: 4 });
		const mainMount = mountDraft(main);
		const sideMount = mountDraft(side);
		registerFiles(mainMount.key);
		registerFiles(sideMount.key);

		// Right-clicking the tree may leave neither editor focused: recency wins.
		side.handle.dom.dispatchEvent(new Event("focusin", { bubbles: true }));
		await addThroughMenu();
		expect(side.value.current).toBe("side @文件1 ");
		expect(main.value.current).toBe("main");

		// Focus beats recency, not mount order.
		main.handle.dom.focus();
		await addThroughMenu();
		expect(main.value.current).toBe("main @文件1 ");
		expect(side.value.current).toBe("side @文件1 ");
	});

	test("a pointer press inside a composer counts as using it", async () => {
		synchronousRaf();
		const main = fakeEditor({ value: "main", start: 4 });
		const side = fakeEditor({ value: "side", start: 4 });
		const mainMount = mountDraft(main);
		const sideMount = mountDraft(side);
		registerFiles(mainMount.key);
		registerFiles(sideMount.key);

		// Clicking the side composer's chip row (not its editor) still means the
		// user is working there; the press is what the intake can observe.
		side.handle.dom.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		await addThroughMenu();
		expect(side.value.current).toBe("side @文件1 ");
		expect(main.value.current).toBe("main");
	});

	test("closing one composer leaves the other live instead of reporting unavailable", async () => {
		synchronousRaf();
		const main = fakeEditor({ value: "main", start: 4 });
		const side = fakeEditor({ value: "side", start: 4 });
		const mainMount = mountDraft(main);
		const sideMount = mountDraft(side);
		registerFiles(mainMount.key);
		registerFiles(sideMount.key);
		side.handle.dom.focus();
		expect(addToChatUnavailableReason()).toBeNull();

		sideMount.unmount();
		expect(addToChatUnavailableReason()).toBeNull();
		await addThroughMenu();
		expect(main.value.current).toBe("main @文件1 ");
	});
});
