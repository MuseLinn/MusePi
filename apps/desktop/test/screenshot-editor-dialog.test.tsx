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
	test("exposes a named surface and an annotation toolbar before an image loads", () => {
		mount();

		expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Screenshot editor");
		expect(document.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe("Screenshot tools");
		expect(document.querySelectorAll('[role="toolbar"] [data-shot-roving][tabindex="0"]')).toHaveLength(1);
	});

	test("offers the drawing tools the board needs, including mosaic and eraser", () => {
		mount();

		const labels = Array.from(document.querySelectorAll('[role="toolbar"] button')).map(button =>
			button.getAttribute("aria-label"),
		);
		for (const label of ["Crop", "Pen", "Arrow", "Rectangle", "Ellipse", "Text", "Mosaic", "Eraser", "Pick color"]) {
			expect(labels).toContain(label);
		}
	});

	test("keeps completion unavailable until image pixels are ready", () => {
		mount();

		const done = document.querySelector<HTMLButtonElement>(".gui-shot-done");
		expect(done?.textContent).toBe("Done");
		expect(done?.disabled).toBe(true);
	});

	test("moves toolbar focus with arrow keys", () => {
		mount();
		const first = document.querySelector<HTMLButtonElement>('[role="toolbar"] button');
		if (!first) throw new Error("first toolbar button did not render");
		first.focus();
		act(() => {
			first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
		});

		expect(document.activeElement?.getAttribute("aria-label")).toBe("Pen");
	});

	test("exposes a HEX/RGBA format switch", () => {
		mount();

		const group = document.querySelector('[aria-label="Color format"]');
		expect(group?.querySelectorAll("button").length).toBe(2);
	});
});
