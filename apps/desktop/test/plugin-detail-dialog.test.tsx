import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PluginDetailDialog } from "../src/components/PluginDetailDialog";
import type { ExtensionItem } from "../src/lib/slot-host";

function item(state: ExtensionItem["state"]): ExtensionItem {
	return {
		id: "computer",
		kind: "computer",
		name: "computer",
		displayName: "Computer Use",
		path: "",
		source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
		state,
		components: [{ id: "computer", name: "computer", enabled: true, canToggle: true }],
	};
}

async function renderDialog(
	state: ExtensionItem["state"],
	overrides: Partial<ExtensionItem> = {},
): Promise<{ cleanup(): Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root: Root = createRoot(host);
	await act(async () => {
		root.render(
			createElement(PluginDetailDialog, {
				open: true,
				onClose: () => {},
				item: { ...item(state), ...overrides },
				rpc: { request: () => Promise.resolve({ ok: true }) } as never,
				onError: () => {},
			}),
		);
	});
	return {
		cleanup: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

describe("PluginDetailDialog component effective state", () => {
	it("keeps a component selection visible but inactive while its parent is disabled", async () => {
		const { cleanup } = await renderDialog("disabled");
		const row = document.querySelector(".gui-plugin-component-row");
		const toggle = row?.querySelector('[role="switch"]');

		expect(toggle?.getAttribute("aria-checked")).toBe("false");
		expect(toggle?.hasAttribute("disabled")).toBe(true);
		expect(row?.textContent).toMatch(/preserved|保留/);
		await cleanup();
	});

	it("allows independent component toggles while the parent is active", async () => {
		const { cleanup } = await renderDialog("active");
		const toggle = document.querySelector(".gui-plugin-component-row [role='switch']");

		expect(toggle?.getAttribute("aria-checked")).toBe("true");
		expect(toggle?.hasAttribute("disabled")).toBe(false);
		await cleanup();
	});

	it("keeps the component list and switches without the redundant description", async () => {
		const { cleanup } = await renderDialog("active", { experimental: true });
		expect(document.querySelector(".gui-plugin-components")).not.toBeNull();
		expect(document.querySelector(".gui-plugin-component-row [role='switch']")).not.toBeNull();
		expect(document.querySelector(".gui-plugin-config-desc")).toBeNull();
		expect(document.querySelector(".gui-dialog-head .gui-ext-item-tag--experimental")?.textContent).toBe(
			"Experimental",
		);
		await cleanup();
	});
});
