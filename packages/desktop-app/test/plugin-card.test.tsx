import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ModuleRow } from "../src/components/UnifiedPluginsView";
import type { ExtensionItem } from "../src/lib/slot-host";

function plugin(): ExtensionItem {
	return {
		id: "subagent-kimi-code",
		kind: "extension-module",
		name: "subagent-kimi-code",
		displayName: "Kimi Code",
		description: "Delegate work to Kimi Code",
		experimental: true,
		path: "",
		source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
		state: "active",
	};
}

describe("shared plugin horizontal card", () => {
	it("opens from click, Enter, and Space and shows the experimental tag", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const opened: ExtensionItem[] = [];
		act(() =>
			root.render(
				createElement(ModuleRow, {
					e: plugin(),
					rpc: {} as never,
					busy: false,
					onOpen: item => opened.push(item),
					onToggle: () => {},
				}),
			),
		);
		const card = host.querySelector<HTMLElement>(".gui-plugin-card")!;
		expect(host.querySelector(".gui-ext-item-tag--experimental")?.textContent).toBe("Experimental");

		act(() => card.click());
		act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
		expect(opened).toHaveLength(3);
		expect(opened.every(item => item.id === "subagent-kimi-code")).toBe(true);

		await act(async () => root.unmount());
		host.remove();
	});

	it("keeps nested switch click and keyboard events from opening details", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		let opened = 0;
		let toggled = 0;
		act(() =>
			root.render(
				createElement(ModuleRow, {
					e: plugin(),
					rpc: {} as never,
					busy: false,
					onOpen: () => opened++,
					onToggle: () => toggled++,
				}),
			),
		);
		const toggle = host.querySelector<HTMLElement>(".gui-plugin-card [role='switch']")!;
		act(() => toggle.click());
		act(() => toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		act(() => toggle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));

		expect(toggled).toBe(1);
		expect(opened).toBe(0);
		await act(async () => root.unmount());
		host.remove();
	});
});
