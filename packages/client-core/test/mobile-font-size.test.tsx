import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InterfaceFontSizeControl } from "../src/components/shell/MobileSettings";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

let root: Root | undefined;

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	document.documentElement.style.removeProperty("--gui-font-scale");
	localStorage.clear();
});

function mount(): void {
	localStorage.setItem("musepi-gui-font-scale", "15");
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(<InterfaceFontSizeControl />));
}

describe("InterfaceFontSizeControl", () => {
	test("uses the desktop storage key and root CSS variable", () => {
		mount();
		const large = document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]:last-child');
		if (!large) throw new Error("large font option did not render");
		act(() => large.click());

		expect(localStorage.getItem("musepi-gui-font-scale")).toBe("17");
		expect(document.documentElement.style.getPropertyValue("--gui-font-scale")).toBe("17px");
		expect(large.getAttribute("aria-checked")).toBe("true");
	});

	test("restores a saved mobile stop", () => {
		localStorage.setItem("musepi-gui-font-scale", "13");
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		act(() => root?.render(<InterfaceFontSizeControl />));

		const selected = document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]');
		expect(selected?.textContent).toBe("Small");
		expect(document.documentElement.style.getPropertyValue("--gui-font-scale")).toBe("13px");
	});
});
