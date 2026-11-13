import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScreenshotEditorDialog } from "../src/components/ScreenshotEditorDialog";

const roots: Root[] = [];

function mount(): void {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => {
		root.render(<ScreenshotEditorDialog open src={null} onConfirm={() => {}} onCancel={() => {}} />);
	});
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("ScreenshotEditorDialog", () => {
	test("exposes a named dialog and toolbar before an image loads", () => {
		mount();

		expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Screenshot editor");
		expect(document.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe("Screenshot tools");
		expect(document.querySelectorAll('[role="toolbar"] button[tabindex="0"]')).toHaveLength(1);
	});

	test("keeps completion unavailable until image pixels are ready", () => {
		mount();

		const done = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
			button => button.textContent === "Done",
		);
		expect(done?.getAttribute("aria-disabled")).toBe("true");
	});

	test("moves toolbar focus with arrow keys when the native focusgroup marker is inert", () => {
		Object.defineProperty(HTMLElement.prototype, "focusGroup", { configurable: true, value: {} });
		mount();
		const first = document.querySelector<HTMLButtonElement>('[role="toolbar"] button');
		if (!first) throw new Error("first toolbar button did not render");
		first.focus();
		act(() => {
			first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
		});

		expect(document.activeElement?.textContent).toBe("Arrow");
		delete (HTMLElement.prototype as Partial<HTMLElement>).focusGroup;
	});
});
