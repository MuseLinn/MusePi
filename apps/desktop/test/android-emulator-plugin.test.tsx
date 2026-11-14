import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { AndroidEmulatorPanel } from "../../../packages/coding-agent/src/bundled-plugins/android-emulator/ui/emulator-panel";

const { act, createElement } = React;
const previousReact = (globalThis as { React?: unknown }).React;
(globalThis as { React?: unknown }).React = React;
const roots = new Set<Root>();
const png = "iVBORw0KGgo=";

afterAll(() => {
	(globalThis as { React?: unknown }).React = previousReact;
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

async function mount(ui: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(ui));
	return { container, root };
}

function extensionCall(calls: Array<{ method: string; params: unknown }>) {
	return async (method: string, params?: unknown) => {
		calls.push({ method, params });
		if (method === "devices")
			return { devices: [{ id: "emulator-5554", state: "device", model: "Pixel_8" }], avds: ["MusePi-Mobile-Test"] };
		if (method === "subscribe" || method === "unsubscribe") return { subscribers: 1 };
		if (method === "frame" || method === "screenshot")
			return { device: "emulator-5554", data: png, mimeType: "image/png", capturedAt: 1 };
		if (method === "uiTree") return { device: "emulator-5554", xml: "<hierarchy />" };
		if (method === "logcat") return { device: "emulator-5554", logs: "ready" };
		return { device: "emulator-5554" };
	};
}

describe("Android emulator panel", () => {
	it("translates a touch on the rendered PNG into device coordinates", async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const { container } = await mount(
			createElement(AndroidEmulatorPanel, { extensionCall: extensionCall(calls), sessionId: "s1", cwd: "D:/work" }),
		);
		const image = container.querySelector("img.android-emulator-screen") as HTMLImageElement | null;
		expect(image).not.toBeNull();
		Object.defineProperties(image, {
			naturalWidth: { value: 1080 },
			naturalHeight: { value: 2160 },
		});
		image!.getBoundingClientRect = () => ({
			left: 100,
			top: 50,
			width: 200,
			height: 400,
			right: 300,
			bottom: 450,
			x: 100,
			y: 50,
			toJSON() {},
		});
		await act(async () => {
			image!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 150, clientY: 150, button: 0 }));
			image!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 150, clientY: 150, button: 0 }));
		});
		expect(calls).toContainEqual({ method: "tap", params: { device: "emulator-5554", x: 270, y: 540 } });
	});

	it("opens the device selected by the tool-provided tab", async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const call = async (method: string, params?: unknown) => {
			calls.push({ method, params });
			if (method === "devices")
				return {
					devices: [
						{ id: "emulator-5554", state: "device", model: "Pixel_8" },
						{ id: "emulator-5556", state: "device", model: "Pixel_9" },
					],
					avds: [],
				};
			if (method === "frame") return { device: "emulator-5556", data: png, mimeType: "image/png", capturedAt: 1 };
			return { subscribers: 1 };
		};
		const { container } = await mount(
			createElement(AndroidEmulatorPanel, {
				extensionCall: call,
				panelTab: {
					id: "android-emulator-5556",
					surface: "ext:panel.tab.android-emulator",
					target: "emulator-5556",
				},
			}),
		);
		expect((container.querySelector("select") as HTMLSelectElement).value).toBe("emulator-5556");
		expect(calls).toContainEqual({ method: "frame", params: { device: "emulator-5556" } });
	});

	it("loads UI hierarchy and logs through the plugin RPC boundary", async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const { container } = await mount(
			createElement(AndroidEmulatorPanel, { extensionCall: extensionCall(calls), sessionId: "s1", cwd: "D:/work" }),
		);
		const buttons = Array.from(container.querySelectorAll("button"));
		const inspect = buttons.find(button => button.textContent === "读取 UI 树");
		const logs = buttons.find(button => button.textContent === "读取日志");
		expect(inspect).toBeDefined();
		expect(logs).toBeDefined();
		await act(async () => inspect!.click());
		expect(container.textContent).toContain("<hierarchy />");
		await act(async () => logs!.click());
		expect(container.textContent).toContain("ready");
		expect(calls.some(call => call.method === "uiTree")).toBe(true);
		expect(calls.some(call => call.method === "logcat")).toBe(true);
	});
});
