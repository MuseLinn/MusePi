import { ComposerEditor, type ComposerEditorHandle } from "@musepi/client-core";
import { createElement, useRef } from "react";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, measure } from "../gui-probe-helpers";

/** Mounts the real composer editor and drives its dictation preview API, which
 *  is what `use-dictation` does on every recognized partial. */
function Harness({ onReady }: { onReady(editor: ComposerEditorHandle): void }) {
	const ref = useRef<ComposerEditorHandle | null>(null);
	return createElement(ComposerEditor, {
		ref: (value: ComposerEditorHandle | null) => {
			ref.current = value;
			if (value) onReady(value);
		},
		value: "",
		placeholder: "描述你想完成的任务，或提问任何内容",
		onChange: () => {},
	});
}

const previewText = "请自然说话，识别文字会显示在这里，不需要等我说完";

export default {
	"dictation-preview": {
		capture: ".musepi-composer-editor",
		async render(root) {
			let editor: ComposerEditorHandle | null = null;
			await mount(createElement(Harness, { onReady: (value: ComposerEditorHandle) => (editor = value) }), root);
			if (!editor) throw new Error("editor did not mount");
			(editor as ComposerEditorHandle).setPreview(previewText);
			await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
		},
		async measure(body) {
			const preview = body.querySelector<HTMLElement>(".musepi-composer-editor__preview");
			const hint = body.querySelector<HTMLElement>(".musepi-composer-editor__placeholder");
			// `measure` reads text/box/computed style only, so the assertions ride on
			// what it can see: the editor's text proves whether the hint is also in
			// the box, and a per-char span's own display proves the effect is real.
			if (preview) {
				const first = preview.querySelector<HTMLElement>(".tr-char");
				if (first) first.setAttribute("data-probe-char", "1");
			}
			const spans = body.querySelectorAll(".musepi-composer-editor__preview .tr-char").length;
			return {
				elements: measure(body, {
					editor: ".musepi-composer-editor",
					preview: ".musepi-composer-editor__preview",
					char: "[data-probe-char]",
				}),
				// A hint rendered underneath the preview would paint its own sentence
				// into the same box; exactly one sentence is the fix.
				hintPresent: hint !== null,
				previewText: preview?.textContent ?? "",
				effect: preview?.dataset.effect ?? "",
				charSpans: spans,
			};
		},
		expect: {
			// The bug the user reported: hint + transcript overlapping. One sentence.
			editor: { text: previewText },
			// Per-character spans are what carries the transcript's entrance effect.
			// A span is inline-block (that is what lets each char animate on its own)
			// while a plain text node is not.
			char: { display: "inline-block", "box.w": { min: 1 } },
		},
	},
} satisfies Record<string, GuiScenario>;
