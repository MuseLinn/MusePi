import { describe, expect, test } from "bun:test";
import type { ComposerAttachment } from "../src/components/composer/use-attachments";
import { attachPaste, createPasteAttachment, saveEditedPaste } from "../src/components/composer/use-long-text-paste";

describe("long paste", () => {
	test("createPasteAttachment summarizes lines and characters", () => {
		const { name, editText } = createPasteAttachment("a\nb\nc");
		expect(name).toContain("3 行");
		expect(name).toContain("5 字符");
		expect(editText).toBe("a\nb\nc");
	});

	test("attachPaste collapses the paste into an editable chip", async () => {
		let added: File[] = [];
		let state: ComposerAttachment[] = [];
		attachPaste({
			text: "line1\nline2",
			addFiles: async files => {
				added = files;
			},
			setAttachments: next => {
				const base: ComposerAttachment[] = [
					{
						id: 1,
						kind: "file",
						dataUrl: "",
						mimeType: "text/markdown",
						name: "paste-x.md",
						size: 5,
						file: added[0],
					},
				];
				state = next(base);
			},
		});
		await Bun.sleep(0);

		expect(added).toHaveLength(1);
		expect(state).toHaveLength(1);
		expect(state[0]?.paste).toBe(true);
		expect(state[0]?.editText).toBe("line1\nline2");
		expect(state[0]?.name).toContain("2 行");
	});

	test("saveEditedPaste replaces content and re-stages upload", async () => {
		const original: ComposerAttachment = {
			id: 1,
			kind: "file",
			dataUrl: "",
			mimeType: "text/markdown",
			name: "paste-1.md",
			size: 4,
			editText: "old",
		};
		const rpc = { request: async () => ({ url: "blob://test" }) };
		let updated: ComposerAttachment = original;
		saveEditedPaste({
			id: 1,
			text: "new\ntext",
			attachments: [original],
			setAttachments: next => {
				updated = typeof next === "function" ? next([original])[0]! : next[0]!;
			},
			rpc: rpc as never,
		});

		expect(updated.editText).toBe("new\ntext");
		expect(updated.file).toBeDefined();
		expect(await updated.file!.text()).toBe("new\ntext");
		expect(updated.staged).toBeDefined();
	});
});
