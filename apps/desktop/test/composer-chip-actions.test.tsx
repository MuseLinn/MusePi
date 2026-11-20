import "./dom-shim";
import { describe, expect, test } from "bun:test";
import { attachmentChipActions, type SketchRequest } from "../src/components/composer/chip-actions";
import type { ComposerAttachment } from "../src/components/composer/use-attachments";

/**
 * Contract (one chip wiring for both composer skins): chip order is the send
 * order and the ordinal is the identity — removing a chip drops the tokens that
 * pointed at it, reordering renumbers the survivors, and the `@` button splices
 * the chip's ordinal token at the caret. Those rules belong to chip order, so
 * they must not depend on which surface rendered the frame.
 */
const chip = (id: number, kind: "image" | "file", name: string): ComposerAttachment => ({
	id,
	kind,
	dataUrl: kind === "image" ? `data:image/png;base64,${id}` : "",
	mimeType: kind === "image" ? "image/png" : "text/markdown",
	name,
	size: 1,
});

function harness(initial: ComposerAttachment[], text: string) {
	let attachments: ComposerAttachment[] = initial;
	let draft = text;
	let sketch: SketchRequest = { open: false, editId: null, initial: null, scene: null };
	const editor = {
		get value() {
			return draft;
		},
		selectionStart: 0,
		selectionEnd: 0,
		dom: document.createElement("div"),
		setSelectionRange: () => {},
		focus: () => {},
		insertText: () => {},
		autosize: () => {},
	};
	const actions = attachmentChipActions({
		attachments,
		setAttachments: next => {
			attachments = typeof next === "function" ? next(attachments) : next;
		},
		setText: next => {
			draft = typeof next === "function" ? next(draft) : next;
		},
		editorRef: { current: editor },
		setSketch: next => {
			sketch = typeof next === "function" ? next(sketch) : next;
		},
		openAddMenu: () => {},
	});
	return { actions, editor, read: () => ({ attachments, draft, sketch }) };
}

describe("attachmentChipActions", () => {
	test("removing a chip drops its tokens and renumbers the survivors", () => {
		const chips = [chip(1, "image", "a.png"), chip(2, "image", "b.png")];
		const h = harness(chips, "@图片1 与 @图片2");
		h.actions.onRemoveAttachment(1);
		const { attachments, draft } = h.read();
		expect(attachments.map(c => c.id)).toEqual([2]);
		// The removed chip degrades to its name form; the survivor becomes 图片1.
		expect(draft).toBe("与 @图片1");
	});

	test("reordering retargets the draft so a token keeps pointing at the same chip", () => {
		const chips = [chip(1, "image", "a.png"), chip(2, "image", "b.png")];
		const h = harness(chips, "@图片1 与 @图片2");
		h.actions.onReorderAttachments(1, 2);
		expect(h.read().attachments.map(c => c.id)).toEqual([2, 1]);
		expect(h.read().draft).toBe("@图片2 与 @图片1");
	});

	test("the mention button splices the ordinal token at the caret", () => {
		const chips = [chip(7, "file", "notes.md")];
		const h = harness(chips, "看这里");
		h.editor.selectionStart = 1;
		h.editor.selectionEnd = 1;
		h.actions.onMentionAttachment(7);
		expect(h.read().draft).toBe("看@文件1 这里");
	});

	test("a sketch chip reopens its scene; a plain image mounts its PNG", () => {
		const scene = { tokens: [] } as unknown as SketchRequest["scene"];
		const chips = [chip(1, "image", "board.png"), chip(2, "image", "plain.png")];
		chips[0]!.sketch = true;
		chips[0]!.sketchScene = scene;
		const h = harness(chips, "");
		h.actions.onEditSketch(1);
		expect(h.read().sketch).toEqual({ open: true, editId: 1, initial: null, scene });
		h.actions.onEditSketch(2);
		expect(h.read().sketch).toEqual({ open: true, editId: 2, initial: chips[1]!.dataUrl, scene: null });
	});
});
