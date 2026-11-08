import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import type { ExtensionAPI, ExtensionComponent } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { RpcClient } from "../src/lib/rpc";
import {
	hostReactBindings,
	hostReactDOMBindings,
	hostReactDOMClientBindings,
	SlotComponentMount,
} from "../src/lib/slot-host";
import { apply } from "../src/plugins/capability-center/index";
import CapabilityCenterPage from "../src/plugins/capability-center/page";

describe("capability-center Cordis plugin", () => {
	it("registers one full-page slot", () => {
		const components: ExtensionComponent[] = [];
		apply({
			setLabel() {},
			slots: {
				register(component: ExtensionComponent) {
					components.push(component);
				},
			},
		} as unknown as ExtensionAPI);
		expect(components).toEqual([expect.objectContaining({ slot: "app.capability", moduleUrl: "./page.tsx" })]);
	});

	it("forwards host page navigation into tab selection", async () => {
		const host = document.createElement("div");
		const root = createRoot(host);
		let selected = "";
		const page = {
			tab: "skills" as const,
			onTabChange(tab: "skills" | "plugins" | "marketplace") {
				selected = tab;
			},
			onBack() {},
		};
		await act(async () => {
			root.render(createElement(CapabilityCenterPage, { rpc: null, page }));
		});
		const tabs = [...host.querySelectorAll<HTMLButtonElement>(".gui-capability-tab")];
		expect(tabs).toHaveLength(3);
		expect(tabs.map(node => node.textContent).join(" ")).not.toContain("组合");
		expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
		await act(async () => tabs[1]?.click());
		expect(selected).toBe("plugins");
		await act(async () => {
			root.render(createElement(CapabilityCenterPage, { rpc: null, page: { ...page, tab: "plugins" } }));
		});
		expect(host.querySelectorAll(".gui-capability-tab")[1]?.getAttribute("aria-selected")).toBe("true");
		await act(async () => root.unmount());
	});

	it("passes page navigation props through the real slot mount", async () => {
		const host = document.createElement("div");
		const root = createRoot(host);
		const item = {
			slot: "app.capability",
			extensionId: "/plugins/capability-center/index.ts",
			code: `export default function Page({ page }) { return window.MusePiReact.createElement("span", null, page.tab); }`,
		};
		await act(async () => {
			root.render(
				createElement(SlotComponentMount, {
					item,
					rpc: null,
					page: { tab: "plugins", onTabChange() {}, onBack() {} },
				}),
			);
		});
		await act(async () => Bun.sleep(20));
		expect(host.textContent).toBe("plugins");
		await act(async () => root.unmount());
	});

	it("does not restart a slow mount when the registry returns the same code in a new object", async () => {
		const host = document.createElement("div");
		const root = createRoot(host);
		const globals = globalThis as { __capabilityCleanup?: number; __capabilityImports?: number };
		const item = {
			slot: "app.capability",
			extensionId: "/plugins/capability-center/index.ts",
			code: `globalThis.__capabilityImports = (globalThis.__capabilityImports ?? 0) + 1;
				await Bun.sleep(60);
				export default function Page() { return window.MusePiReact.createElement("span", null, "mounted"); }
				export function apply(ctx) { ctx.effect(() => { globalThis.__capabilityCleanup = (globalThis.__capabilityCleanup ?? 0) + 1; }); }`,
		};
		await act(async () => {
			root.render(createElement(SlotComponentMount, { item, rpc: null }));
		});
		await act(async () => Bun.sleep(10));
		await act(async () => {
			root.render(createElement(SlotComponentMount, { item: { ...item }, rpc: null }));
		});
		await act(async () => Bun.sleep(90));
		expect(host.textContent).toBe("mounted");
		expect(globals.__capabilityImports).toBe(1);
		expect(globals.__capabilityCleanup).toBeUndefined();
		await act(async () => root.unmount());
		expect(globals.__capabilityCleanup).toBe(1);
		delete globals.__capabilityCleanup;
		delete globals.__capabilityImports;
	});

	it("no longer hosts the running-plugin status strip", async () => {
		const rpc = {
			request: async (method: string): Promise<unknown> => {
				if (method === "extensions.list") {
					return {
						extensions: [
							{ id: "alpha", kind: "plugin-module", name: "alpha", displayName: "Alpha", state: "active" },
						],
					};
				}
				if (method === "plugins.packages") return { plugins: [] };
				if (method === "skills.list") return { skills: [] };
				if (method === "marketplace.list") return { entries: [] };
				if (method === "marketplace.sources.list") return { sources: [] };
				return {};
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const host = document.createElement("div");
		const root = createRoot(host);
		const page = {
			tab: "plugins" as const,
			onTabChange() {},
			onBack() {},
		};
		await act(async () => {
			root.render(createElement(CapabilityCenterPage, { rpc, page }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		// The session info card owns the running-plugin readout now; this
		// management page keeps only the unified plugin list.
		expect(host.textContent).not.toContain(t("settings.extensionsRunning", { count: "1" }));
		await act(async () => root.unmount());
	});

	it("exposes the complete host React bindings required by the page graph", () => {
		expect(hostReactBindings.createContext).toBeTypeOf("function");
		expect(hostReactBindings.forwardRef).toBeTypeOf("function");
		expect(hostReactBindings.jsx).toBeTypeOf("function");
		expect(hostReactDOMBindings.createPortal).toBeTypeOf("function");
		expect(hostReactDOMClientBindings.createRoot).toBeTypeOf("function");
	});
});
