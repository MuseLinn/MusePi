/**
 * Settings → 快捷提示词: the row list is the manager for the welcome
 * composer's chips. Drag reorder is layout-dependent (verified in the real
 * renderer); here we lock the row structure, the editor round-trip and the
 * persistence contract.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptsSection } from "../src/components/settings-sections/suggestions";
import { loadUserSuggestions, SUGGESTIONS_STORAGE_KEY } from "../src/lib/suggestions";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
	localStorage.clear();
	setLocale("en-US");
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
});

function mount(): HTMLDivElement {
	const element = document.createElement("div");
	document.body.appendChild(element);
	root = createRoot(element);
	act(() => root?.render(createElement(PromptsSection)));
	host = element;
	return element;
}

function stored(): unknown[] {
	return JSON.parse(localStorage.getItem(SUGGESTIONS_STORAGE_KEY) ?? "[]") as unknown[];
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
	const props = key ? (element as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key] : undefined;
	if (!props?.onChange) throw new Error("no React onChange handler");
	act(() => {
		element.value = value;
		props.onChange?.({ target: element, currentTarget: element });
	});
}

describe("starter prompts settings", () => {
	it("lists every prompt with a drag handle and a built-in tag", () => {
		const defaults = loadUserSuggestions();
		const scope = mount();
		expect(scope.querySelectorAll(".gui-suggest-row").length).toBe(defaults.length);
		expect(scope.querySelectorAll(".gui-suggest-grip").length).toBe(defaults.length);
		expect(scope.querySelectorAll(".gui-suggest-badge").length).toBe(defaults.length);
	});

	it("edits a built-in prompt into a custom one and persists it", () => {
		const scope = mount();
		act(() => scope.querySelector<HTMLButtonElement>(".gui-suggest-action")?.click());
		const editor = scope.querySelector(".gui-suggest-editor");
		expect(editor).not.toBeNull();
		const label = editor?.querySelector<HTMLInputElement>("input");
		if (!label) throw new Error("no label input");
		setValue(label, "My prompt");
		act(() => scope.querySelector<HTMLButtonElement>(".gui-suggest-editor .gui-btn-approve")?.click());

		const saved = stored()[0] as { label: string; prompt: string };
		expect(saved.label).toBe("My prompt");
		expect(typeof saved.prompt).toBe("string");
		expect(saved.prompt.length).toBeGreaterThan(0);
		// The edited row is custom now — no built-in tag.
		const firstRow = scope.querySelector(".gui-suggest-row");
		expect(firstRow?.querySelector(".gui-suggest-badge")).toBeNull();
		expect(firstRow?.querySelector(".gui-suggest-row-label")?.textContent).toBe("My prompt");
	});

	it("removes a row, appends a new one, and resets to defaults", () => {
		const scope = mount();
		const total = loadUserSuggestions().length;
		act(() => scope.querySelector<HTMLButtonElement>(".gui-suggest-action--danger")?.click());
		expect(stored().length).toBe(total - 1);

		act(() => scope.querySelector<HTMLButtonElement>(".gui-suggest-add")?.click());
		const editor = scope.querySelector(".gui-suggest-editor");
		const inputs = editor?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
		if (!inputs || inputs.length < 2) throw new Error("no editor fields");
		setValue(inputs[0]!, "Fresh");
		setValue(inputs[1]!, "Do the fresh thing");
		act(() => scope.querySelector<HTMLButtonElement>(".gui-suggest-editor .gui-btn-approve")?.click());
		const saved = stored().at(-1) as { label: string; prompt: string };
		expect(saved).toEqual({ label: "Fresh", prompt: "Do the fresh thing" });

		act(() => scope.querySelector<HTMLButtonElement>(".gui-suggest-reset")?.click());
		expect(localStorage.getItem(SUGGESTIONS_STORAGE_KEY)).toBeNull();
		expect(scope.querySelectorAll(".gui-suggest-row").length).toBe(total);
	});
});
