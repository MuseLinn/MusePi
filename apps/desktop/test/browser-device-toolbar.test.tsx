import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
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

function renderToolbar(disabled = false, calls: string[] = [], visible = true): string[] {
	act(() =>
		root.render(
			<BrowserDeviceToolbar
				disabled={disabled}
				visible={visible}
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

function trigger(className: string): HTMLButtonElement {
	return host.querySelector<HTMLButtonElement>(`.gui-select-trigger.${className}`)!;
}

function press(element: Element, key: string): void {
	act(() => {
		element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
}

function option(label: string): HTMLButtonElement {
	return [...document.querySelectorAll<HTMLButtonElement>(".gui-select-opt")].find(
		element => element.textContent?.trim() === label,
	)!;
}

describe("BrowserDeviceToolbar compact state", () => {
	it("renders nothing at all while hidden", () => {
		renderToolbar(false, [], false);
		expect(host.querySelector(".gui-browser-toolbar")).toBeNull();
		expect(host.textContent?.trim()).toBe("");
	});

	it("always exposes the selected preset and background as text", () => {
		renderToolbar();
		expect(trigger("gui-browser-toolbar-preset").textContent).toContain(t("tools.browserViewportPhone"));
		expect(trigger("gui-browser-toolbar-background").textContent).toContain(t("tools.browserBackgroundAuto"));
		expect(host.querySelector(".gui-browser-toolbar-toggle")).toBeNull();
	});
});

describe("BrowserDeviceToolbar disabled state", () => {
	it("disables every page-emulation control", () => {
		renderToolbar(true);
		expect(trigger("gui-browser-toolbar-preset").disabled).toBe(true);
		expect(trigger("gui-browser-toolbar-background").disabled).toBe(true);
		expect(trigger("gui-browser-toolbar-scale").disabled).toBe(true);
		expect(
			Array.from(host.querySelectorAll<HTMLInputElement>(".gui-browser-toolbar-input")).every(
				input => input.disabled,
			),
		).toBe(true);
	});

	it("does not open a preset menu by pointer or keyboard", () => {
		const calls = renderToolbar(true);
		const preset = trigger("gui-browser-toolbar-preset");
		act(() => preset.click());
		press(preset, "Enter");
		expect(document.querySelector(".gui-select-menu")).toBeNull();
		expect(calls).toEqual([]);
	});

	it("closes an open scale menu without allowing pointer submission after becoming disabled", async () => {
		const calls = renderToolbar();
		const scale = trigger("gui-browser-toolbar-scale");
		act(() => scale.click());
		const selected = option("50%");
		expect(selected).not.toBeNull();
		renderToolbar(true, calls);
		act(() => selected!.click());
		expect(calls).toEqual([]);
		await act(async () => Bun.sleep(220));
		expect(document.querySelector(".gui-select-menu") === null).toBe(true);
	});

	it("closes an open scale menu without allowing Enter submission after becoming disabled", async () => {
		const calls = renderToolbar();
		const scale = trigger("gui-browser-toolbar-scale");
		act(() => scale.click());
		expect(document.querySelector(".gui-select-menu")).not.toBeNull();
		press(scale, "ArrowDown");
		renderToolbar(true, calls);
		press(scale, "Enter");
		expect(calls).toEqual([]);
		await act(async () => Bun.sleep(220));
		expect(document.querySelector(".gui-select-menu") === null).toBe(true);
	});

	it("keeps disabled dimensions out of keyboard focus order", () => {
		renderToolbar(true);
		const width = host.querySelector<HTMLInputElement>(".gui-browser-toolbar-input");
		act(() => width!.focus());
		expect(document.activeElement === width).toBe(false);
	});
});

describe("BrowserDeviceToolbar enabled interaction", () => {
	it("commits dimensions on Enter", () => {
		const calls = renderToolbar();
		const width = host.querySelector<HTMLInputElement>(".gui-browser-toolbar-input");
		act(() => width!.focus());
		press(width!, "Enter");
		expect(calls).toEqual(["size:393x852"]);
	});

	it("resizes through the slider controls as well as the number inputs", () => {
		const calls = renderToolbar();
		act(() => host.querySelector<HTMLButtonElement>(".gui-browser-toolbar-resize")!.click());
		const slider = document.querySelector<HTMLInputElement>(".gui-browser-size-controls input[type=range]")!;
		act(() => {
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(slider, "512");
			slider.dispatchEvent(new Event("input", { bubbles: true }));
			slider.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(calls).toContain("size:512x852");
	});

	it("chooses presets and backgrounds from their labelled menus", async () => {
		const calls = renderToolbar();
		const preset = trigger("gui-browser-toolbar-preset");
		act(() => preset.click());
		act(() => option(t("tools.browserViewportTablet")).click());
		await act(async () => Bun.sleep(180));

		const background = trigger("gui-browser-toolbar-background");
		act(() => background.click());
		act(() => option(t("tools.browserBackgroundLight")).click());
		expect(calls).toEqual(["preset:tools.browserViewportTablet", "background:light"]);
	});
});
