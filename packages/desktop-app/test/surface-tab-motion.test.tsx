import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SurfaceTabStrip as SurfaceTabStripComponent } from "../src/components/surface-tabs";

let SurfaceTabStrip: typeof SurfaceTabStripComponent;

beforeAll(async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register();
	({ SurfaceTabStrip } = await import("../src/components/surface-tabs"));
});

afterAll(async () => {
	await GlobalRegistrator.unregister();
	await GlobalRegistrator.register();
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function render(closing: boolean): void {
	const tabs = closing
		? [{ id: "a", title: "A" }]
		: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			];
	act(() =>
		root.render(
			<SurfaceTabStrip tabs={tabs} activeId="a" onActivate={() => {}} onClose={() => {}} onReorder={() => {}} />,
		),
	);
}

describe("SurfaceTabStrip motion accessibility", () => {
	test("a closing tab is inert and leaves tab and drag semantics immediately", async () => {
		render(false);
		render(true);
		const closing = host.querySelector("[data-motion='closing']");
		expect(closing).not.toBeNull();
		expect(closing?.getAttribute("aria-hidden")).toBe("true");
		expect(closing?.hasAttribute("inert")).toBe(true);
		expect(closing?.getAttribute("role")).not.toBe("tab");
		expect(closing?.getAttribute("tabindex")).not.toBe("0");
		await act(async () => Bun.sleep(180));
		expect(host.querySelector("[data-motion='closing']")).toBeNull();
	});
});
