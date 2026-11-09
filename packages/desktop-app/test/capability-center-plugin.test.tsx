import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import type { ExtensionAPI, ExtensionComponent } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { clearCapabilityNav, emitCapabilityNavAction, readCapabilityNav } from "../src/lib/capability-nav";
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

	it("moves the three tabs out of the page header into the second-tier panel bridge", async () => {
		clearCapabilityNav();
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
		// The page header owns the title/description/back path only — the three
		// destinations now live in the rail's `sidebar.panel.capability` pane.
		expect(host.querySelectorAll(".gui-capability-tab")).toHaveLength(0);
		expect(host.querySelectorAll(".gui-capability-pane")).toHaveLength(5); // 3 tabs + 2 技能 sub-panes
		expect(host.querySelectorAll(".gui-capability-pane--on")).toHaveLength(2); // skills + nested discover
		expect(host.querySelectorAll(".gui-capability-body > .gui-capability-pane--on")).toHaveLength(1);
		expect(readCapabilityNav().tab).toBe("skills");

		// Panel → page: a row click and the full-width primary CTA both drive
		// the host's controlled tab state.
		await act(async () => emitCapabilityNavAction({ type: "select", tab: "plugins" }));
		expect(selected).toBe("plugins");
		await act(async () => emitCapabilityNavAction({ type: "add" }));
		expect(selected).toBe("marketplace");

		// Page → panel: a controlled tab change re-publishes one projection and
		// switches exactly one pane on.
		await act(async () => {
			root.render(createElement(CapabilityCenterPage, { rpc: null, page: { ...page, tab: "marketplace" } }));
		});
		expect(readCapabilityNav().tab).toBe("marketplace");
		// Only ONE top-level pane is on; the 技能 sub-pane keeps its own
		// independent discover/installed flag (it stays mounted).
		expect(host.querySelectorAll(".gui-capability-body > .gui-capability-pane--on")).toHaveLength(1);
		const topPanes = [...host.querySelectorAll(".gui-capability-body > .gui-capability-pane")];
		expect(topPanes[2]?.classList.contains("gui-capability-pane--on")).toBe(true);
		await act(async () => root.unmount());
		// Unmount clears the projection so a later visit never flashes stale counts.
		expect(readCapabilityNav()).toEqual({ tab: "skills", skillsCount: 0, pluginsCount: 0 });
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
