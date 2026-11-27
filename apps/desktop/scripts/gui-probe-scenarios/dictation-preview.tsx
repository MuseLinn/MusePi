import { ComposerEditor, type ComposerEditorHandle } from "@musepi/client-core";
import { createElement } from "react";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, measure } from "../gui-probe-helpers";

/** The dictation's provisional paint: the words are real document text, shown
 *  muted until the dictation is committed. This scenario checks the two things
 *  the user reported directly — that the empty-composer hint does not overlap
 *  the transcript, and that the words live in the draft. */
export default {
	"dictation-preview": {
		capture: ".musepi-composer-editor",
		async render(root) {
			let editor: ComposerEditorHandle | null = null;
			await mount(
				createElement(ComposerEditor, {
					ref: (value: ComposerEditorHandle | null) => {
						editor = value;
					},
					value: "",
					placeholder: "描述你想完成的任务，或提问任何内容",
					onChange: () => {},
				}),
				root,
			);
			const handle = editor as ComposerEditorHandle | null;
			if (!handle) throw new Error("editor did not mount");
			handle.setSelectionRange(0);
			handle.writeDictation("", "请自然说话，识别文字会显示在这里", true);
			await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
		},
		async measure(body) {
			const preview = body.querySelector<HTMLElement>(".musepi-composer-editor__preview");
			return {
				elements: measure(body, {
					editor: ".musepi-composer-editor",
					preview: ".musepi-composer-editor__preview",
				}),
				// A hint drawn under the transcript would paint a second sentence
				// into the same box.
				placeholders: body.querySelectorAll(".musepi-composer-editor__placeholder").length,
				text: preview?.textContent ?? "",
			};
		},
		expect: {
			// The probe asserts through element readings; the editor's text is the
			// transcript, with no hint drawn alongside it.
			editor: { text: "请自然说话，识别文字会显示在这里" },
			preview: { display: "inline", "box.w": { min: 1 } },
		},
	},
} satisfies Record<string, GuiScenario>;
