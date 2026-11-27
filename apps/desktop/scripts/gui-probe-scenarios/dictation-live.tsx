import { ComposerEditor } from "@musepi/client-core";
import { createElement } from "react";
import { VoiceButton, VoiceStatusStrip } from "../../src/components/composer/action-buttons";
import { mount, measure } from "../gui-probe-helpers";

/** The composer in its live-dictation shape: status strip + the editor that
 *  paints the volatile preview. This is the exact composition SessionComposer
 *  renders (`VoiceOverlays` above `ComposerEditorStack`). */
type ProbeEditor = {
	writeDictation(c: string, h: string, restart: boolean): void;
	commitDictation(): void;
	setSelectionRange(start: number): void;
};

function Live({
	phase,
	level,
	onEditor,
}: {
	phase: "recording" | "transcribing";
	level: number;
	/** Hands the mounted editor handle to the scenario. */
	onEditor?(editor: ProbeEditor): void;
}) {
	return createElement(
		"div",
		{ className: "gui-composer-frame gui-liquid-glass" },
		createElement(VoiceStatusStrip, { phase, seconds: 6, level }),
		createElement(ComposerEditor, {
			value: "note:  here",
			// The composers pass no placeholder while dictating.
			placeholder: "",
			onChange: () => {},
			ref: (editor: ProbeEditor | null) => {
				if (editor) onEditor?.(editor);
			},
		}),
		// Real structure: the state line sits ABOVE the editor and the mic
		// capsule is part of the toolbar BELOW it, so the two never share a row.
		createElement(
			"div",
			{ className: "gui-composer-row" },
			createElement(VoiceButton, { state: phase, onToggle: () => {} }),
		),
	);
}

const transcriptText = "note: 第一句第二句 here";

export default {
	"dictation-live": {
		capture: ".gui-composer-frame",
		async render(root) {
			let editor: ProbeEditor | null = null;
			await mount(
				createElement(Live, { phase: "recording", level: 0.62, onEditor: value => (editor = value) }),
				root,
			);
			if (!editor) throw new Error("editor did not mount");
			const handle = editor as ProbeEditor;
			// Mid-draft dictation, two phrases: the case that used to scatter —
			// the second phrase must follow the first and the draft's tail survive.
			handle.setSelectionRange(6);
			handle.writeDictation("", "第一句", true);
			handle.writeDictation("第一句", "第二句", false);
			// The stream ends: the words become ordinary draft text and the
			// provisional paint is retired (the "still looks like a preview"
			// report came from a region that outlived its dictation).
			handle.commitDictation();
			await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
		},
		async measure(body) {
			const frame = body.querySelector<HTMLElement>(".gui-composer-frame");
			const strip = body.querySelector<HTMLElement>(".gui-voice-strip");
			if (frame) frame.setAttribute("data-probe-children", String(frame.children.length));
			return {
				elements: measure(body, {
					frame: ".gui-composer-frame",
					strip: ".gui-voice-strip",
					label: ".gui-voice-strip-label",
					editor: ".musepi-composer-editor",
					capsule: ".gui-composer-ico--dictating",
				}),
				stripH: Math.round(strip?.getBoundingClientRect().height ?? 0),
				// Nothing in the strip may duplicate the capsule's clock/level.
				rings: body.querySelectorAll(".gui-voice-ring").length,
				bars: body.querySelectorAll(".gui-voice-wave i").length,
				meters: body.querySelectorAll(".gui-voice-meter").length,
				stripTime: body.querySelector(".gui-voice-strip-time")?.textContent ?? "",
				// The button must stay a plain icon: no clock, no meter inside it.
				buttonSeconds: body.querySelectorAll(".gui-composer-ico--dictating .gui-voice-seconds").length,
				buttonMeter: body.querySelectorAll(".gui-composer-ico--dictating .gui-voice-meter").length,
				// Dictating replaces the "what you could type" hint with the act of
				// speaking; two instructions in one box compete.
				placeholders: body.querySelectorAll(".musepi-composer-editor__placeholder").length,
				// After the dictation ended nothing may still be painted as a guess.
				provisional: body.querySelectorAll(".musepi-composer-editor__preview").length,
				// The capsule carries both, inside the control they describe.

			};
		},
		expect: {
			frame: { "box.w": { min: 300 } },
			// One thin line: the old strip was 36px tall on its own.
			strip: { display: "flex", "box.h": { max: 28 } },
			// Reads as part of the message column, not as an indented badge.
			label: { "box.h": { min: 14 } },
			// The editor's only text is the live transcript — no hint is drawn
			// alongside it, which is what the old strip's copy used to do.
			editor: { text: transcriptText },
		},
	},
	"dictation-transcribing": {
		capture: ".gui-composer-frame",
		async render(root) {
			await mount(createElement(Live, { phase: "transcribing", level: 0 }), root);
			await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
		},
		async measure(body) {
			return {
				elements: measure(body, { strip: ".gui-voice-strip", spinner: ".gui-voice-spinner" }),
				seconds: body.querySelectorAll(".gui-voice-seconds").length,
			};
		},
		expect: {
			strip: { display: "flex", "box.h": { max: 28 } },
			// The wait has no clock: a counter would claim recording continues.
			spinner: { "box.w": { min: 8 } },
		},
	},
} satisfies Record<string, GuiScenario>;

type GuiScenario = import("../gui-probe-helpers").GuiScenario;
