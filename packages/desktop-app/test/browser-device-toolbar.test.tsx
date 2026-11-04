import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserDeviceToolbar } from "../src/components/browser-device-toolbar";

const HIDDEN_KEY = "musepi-gui-browser-device-toolbar";
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	window.localStorage.removeItem(HIDDEN_KEY);
	host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	window.localStorage.removeItem(HIDDEN_KEY);
});

function renderToolbar(disabled = false): string[] {
	const calls: string[] = [];
	act(() =>
		root.render(
			<BrowserDeviceToolbar
				disabled={disabled}
				preset="tools.browserViewportPhone"
				width={393}
				height={852}
				displayScale="fit"
				background="auto"
				onPresetChange={preset => calls.push(`preset:${preset}`)}
				onSizeChange={size => calls.push(`size:${size.width}x${size.height}`)}
				onDisplayScaleChange={scale => calls.push(`scale:${scale}`)}
				onBackgroundChange={background => calls.push(`background:${background}`)}
			/>,
		),
	);
	return calls;
}

function presets(): HTMLButtonElement[] {
	return Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-browser-toolbar-presets .gui-seg-item"));
}

function backgrounds(): HTMLButtonElement[] {
	return Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-browser-toolbar-swatch"));
}

function press(element: Element, key: string): void {
	act(() => {
		element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
}

describe("BrowserDeviceToolbar disabled state", () => {
	it("exposes native and ARIA disabled state while keeping collapse and reveal available", () => {
		renderToolbar(true);
		expect(host.querySelector(".gui-browser-toolbar-presets")?.getAttribute("aria-disabled")).toBe("true");
		expect(host.querySelector(".gui-browser-toolbar-bg")?.getAttribute("aria-disabled")).toBe("true");
		expect(presets().every(button => button.disabled)).toBe(true);
		expect(backgrounds().every(button => button.disabled)).toBe(true);
		expect(
			Array.from(host.querySelectorAll<HTMLInputElement>(".gui-browser-toolbar-input")).every(
				input => input.disabled,
			),
		).toBe(true);
		expect(host.querySelector<HTMLButtonElement>(".gui-select-trigger")?.disabled).toBe(true);

		const toggle = host.querySelector<HTMLButtonElement>(".gui-browser-toolbar-toggle");
		expect(toggle?.disabled).toBe(false);
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		act(() => toggle!.click());
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(host.querySelector(".gui-browser-toolbar-body")).toBeNull();
		expect(window.localStorage.getItem(HIDDEN_KEY)).toBe("hidden");
		act(() => toggle!.click());
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(host.querySelector(".gui-browser-toolbar-body")).not.toBeNull();
		expect(window.localStorage.getItem(HIDDEN_KEY)).toBeNull();
	});

	it("does not activate disabled presets by pointer or keyboard", () => {
		const calls = renderToolbar(true);
		act(() => presets()[0]!.click());
		press(presets()[1]!, "ArrowRight");
		press(presets()[1]!, "Home");
		expect(calls).toEqual([]);
	});

	it("does not activate disabled backgrounds by pointer or keyboard", () => {
		const calls = renderToolbar(true);
		act(() => backgrounds()[1]!.click());
		press(backgrounds()[0]!, "ArrowRight");
		press(backgrounds()[0]!, "End");
		expect(calls).toEqual([]);
	});

	it("does not commit disabled dimensions from the keyboard", () => {
		const calls = renderToolbar(true);
		const width = host.querySelector<HTMLInputElement>(".gui-browser-toolbar-input");
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Enter" });
		act(() => {
			width!.dispatchEvent(event);
		});
		expect(calls).toEqual([]);
	});
});

describe("BrowserDeviceToolbar enabled keyboard interaction", () => {
	it("retains preset and background keyboard navigation", () => {
		const calls = renderToolbar();
		press(presets()[1]!, "ArrowRight");
		expect(document.activeElement).toBe(presets()[2]);
		press(backgrounds()[0]!, "ArrowRight");
		expect(calls).toEqual(["preset:tools.browserViewportTablet", "background:light"]);
		press(presets()[2]!, "Home");
		expect(calls).toEqual([
			"preset:tools.browserViewportTablet",
			"background:light",
			"preset:tools.browserViewportFit",
		]);
		expect(document.activeElement).toBe(presets()[0]);
	});
});
