import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarketplaceView } from "../src/components/MarketplaceView";
import { PromptProvider } from "../src/lib/prompt-dialog";
import type { RpcClient } from "../src/lib/rpc";

const roots: Array<{ root: Root; host: HTMLElement }> = [];
beforeEach(() => {
	localStorage.clear();
});
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	localStorage.clear();
});

const ENTRY = {
	name: "modern-web-guidance",
	marketplace: "googlechrome",
	version: "0.0.197",
	description: "Modern Web best practices",
	installed: true,
	enabled: true,
	installedScope: "user",
	installedVersion: "0.0.197",
};

function makeRpc(): { rpc: RpcClient; calls: Array<{ method: string; params: unknown }> } {
	const calls: Array<{ method: string; params: unknown }> = [];
	const rpc = {
		request: async (method: string, params: unknown) => {
			calls.push({ method, params });
			if (method === "marketplace.list") return { entries: [ENTRY] };
			if (method === "marketplace.sources.list") return { sources: [] };
			if (method === "marketplace.detail") {
				return {
					...ENTRY,
					displayName: "Modern Web Guidance",
					longDescription: "Complete browser compatibility guidance from Google Chrome.",
					icon: "https://example.com/logo.png",
					capabilities: ["Read"],
					skills: [
						{ name: "chrome-extensions", description: "Build Chrome extensions" },
						{ name: "modern-web-guidance", description: "Search modern Web guidance" },
					],
				};
			}
			if (method === "plugins.setEnabled") return { ok: true };
			throw new Error(`unexpected rpc: ${method}`);
		},
	} as unknown as RpcClient;
	return { rpc, calls };
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function renderView(rpc: RpcClient): Promise<void> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => {
		root.render(createElement(PromptProvider, null, createElement(MarketplaceView, { rpc })));
	});
	await flush();
}

async function openDetails(): Promise<void> {
	await act(async () => {
		document.querySelector<HTMLButtonElement>('button[aria-label="modern-web-guidance details"]')?.click();
	});
	await flush();
}

describe("marketplace detail view", () => {
	it("shows full metadata and skills and toggles the real plugin state", async () => {
		const { rpc, calls } = makeRpc();
		await renderView(rpc);
		await openDetails();

		const dialog = document.querySelector(".gui-marketplace-detail");
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain("Modern Web Guidance");
		expect(dialog?.textContent).toContain("Complete browser compatibility guidance from Google Chrome.");
		expect(dialog?.textContent).toContain("chrome-extensions");
		expect(dialog?.textContent).toContain("Search modern Web guidance");
		expect(dialog?.querySelector("img")?.getAttribute("src")).toBe("https://example.com/logo.png");

		const toggle = dialog?.querySelector<HTMLButtonElement>('[role="switch"]');
		expect(toggle?.getAttribute("aria-checked")).toBe("true");
		await act(async () => toggle?.click());
		expect(calls.filter(call => call.method === "plugins.setEnabled").map(call => call.params)).toEqual([
			{ name: "modern-web-guidance", enabled: false },
		]);
		expect(toggle.getAttribute("aria-checked")).toBe("false");
	});

	it("restores the open detail after a renderer remount", async () => {
		const { rpc } = makeRpc();
		await renderView(rpc);
		await openDetails();
		for (const { root, host } of roots.splice(0)) {
			await act(async () => root.unmount());
			host.remove();
		}

		await renderView(rpc);
		expect(document.querySelector(".gui-marketplace-detail")?.textContent).toContain("Modern Web Guidance");
	});
});
