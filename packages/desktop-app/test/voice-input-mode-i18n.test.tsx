/**
 * 设置 → 语音 → 朗读内容 (tts.inputMode): enum choices must render translated
 * labels, never the bare stored ids.
 *
 * The daemon synthesizes ui.options from `values` as { value, label: value }
 * when a setting declares no options, and the GUI resolves each label through
 * t(). A bare id has no translation, so the dropdown painted "raw" /
 * "sanitize" / "summarize". This test feeds the REAL schema definition into
 * SchemaSettings so the contract cannot drift away from settings-schema.ts.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale, tLoose } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SETTINGS_SCHEMA } from "../../coding-agent/src/config/settings-schema";
import { isSettingShown, SchemaSettings } from "../src/components/SchemaSettings";
import "../src/i18n/voice"; // registers the zh/en voice translation overlay.

type SchemaItem = Parameters<typeof SchemaSettings>[0]["items"][number];

const def = SETTINGS_SCHEMA["tts.inputMode"] as unknown as {
	type: "enum";
	default: string;
	ui: Record<string, unknown> & { options: { value: string; label: string }[] };
};
const item = {
	key: "tts.inputMode",
	type: def.type,
	default: def.default,
	ui: def.ui,
} as SchemaItem;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	setLocale("en-US");
});

function mount(locale: "zh-CN" | "en-US", value = "sanitize"): HTMLDivElement {
	setLocale(locale);
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	act(() => {
		root?.render(
			createElement(SchemaSettings, {
				items: [item],
				values: { "tts.inputMode": value },
				onChange: () => {},
			}),
		);
	});
	host = el;
	return el;
}

/** Text of the closed trigger and of every option after opening the menu. */
function dropdownTexts(scope: HTMLElement): { trigger: string; options: string[] } {
	const trigger = scope.querySelector<HTMLButtonElement>(".gui-select-trigger");
	if (!trigger) throw new Error("no enum select rendered");
	act(() => trigger.click());
	const options = [...document.querySelectorAll(".gui-select-opt")].map(o => o.textContent ?? "");
	return { trigger: trigger.textContent ?? "", options };
}

describe("tts.inputMode enum labels", () => {
	it("declares translatable labels instead of bare ids", () => {
		setLocale("zh-CN");
		const labels = def.ui.options.map(o => o.label);
		expect(def.ui.options.map(o => o.value)).toEqual(["raw", "sanitize", "summarize"]);
		expect(labels).toEqual(["Raw text", "Sanitized (no code/markdown)", "Summarized"]);
		// Every declared label resolves through the voice overlay; a bare id
		// like "sanitize" would fall back to itself here.
		for (const label of labels) expect(tLoose(label)).not.toBe(label);
	});

	it("renders Chinese labels in the trigger and the open list", () => {
		const scope = mount("zh-CN");
		const { trigger, options } = dropdownTexts(scope);
		expect(trigger).toBe("净化（去代码/Markdown）");
		expect(options).toEqual(["原文", "净化（去代码/Markdown）", "精简（前两句）"]);
		for (const text of [trigger, ...options]) {
			expect(text).not.toMatch(/^(raw|sanitize|summarize)$/);
		}
	});

	it("renders readable English labels instead of ids in en-US", () => {
		mount("en-US", "raw");
		const trigger = host?.querySelector<HTMLButtonElement>(".gui-select-trigger");
		expect(trigger?.textContent).toBe("Raw text");
		expect(trigger?.textContent).not.toBe("raw");
	});

	it("lets the voice page override plugin conditions instead of defaulting to visible", () => {
		const item = { ui: { condition: "ttsPluginEnabled" } };
		// GUI CONDITIONS has no plugin registry entry; without an override the
		// row would silently show even while the TTS package is disabled.
		expect(isSettingShown(item, {})).toBe(true);
		expect(isSettingShown(item, {}, { ttsPluginEnabled: () => false })).toBe(false);
		expect(isSettingShown(item, {}, { ttsPluginEnabled: () => true })).toBe(true);
		expect(isSettingShown({ ui: undefined }, {})).toBe(true);
	});

	it("applies the override to the row Reveal, not only the group", () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		act(() =>
			root.render(
				createElement(SchemaSettings, {
					items: [
						{
							key: "tts.autoRead",
							type: "boolean" as const,
							default: false,
							ui: { label: "Auto-read new replies", condition: "ttsPluginEnabled" },
						},
					],
					values: {},
					onChange: () => {},
					conditions: { ttsPluginEnabled: () => false },
				}),
			),
		);
		// Both the group Reveal and the per-row Reveal must stay collapsed;
		// a row-level fallback to CONDITIONS would leave this open.
		expect(el.querySelector(".gui-collapse--open")).toBeNull();
		act(() => root.unmount());
		el.remove();
	});
});
