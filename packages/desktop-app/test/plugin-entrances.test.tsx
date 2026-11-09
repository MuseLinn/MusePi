import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { UnifiedPluginsView } from "../src/components/UnifiedPluginsView";
import type { RpcClient } from "../src/lib/rpc";
import type { ExtensionItem } from "../src/lib/slot-host";

function builtin(overrides: Partial<ExtensionItem> & Pick<ExtensionItem, "id" | "name">): ExtensionItem {
	return {
		kind: "plugin-module",
		displayName: overrides.name,
		path: `/plugins/${overrides.name}/index.ts`,
		source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
		state: "active",
		builtin: true,
		...overrides,
	};
}

const MODULES: ExtensionItem[] = [
	builtin({ id: "musepi-board", name: "board", displayName: "Board" }),
	builtin({
		id: "musepi-terminal",
		name: "terminal",
		displayName: "Terminal",
		readonly: true,
		config: [{ key: "backend", type: "string", label: "Backend" }],
	}),
	builtin({ id: "musepi-tool-cards", name: "tool-cards", displayName: "Tool cards", readonly: true }),
	builtin({ id: "musepi-preset-chat", name: "preset-chat", displayName: "Chat persona", presetOnly: true }),
];

const PRESETS = [
	{
		id: "work",
		label: "Work",
		isDefault: true,
		rows: [
			{ name: "board", entryId: "include:board", enabled: true, fiberPhase: "active" as const },
			{ name: "terminal", entryId: "include:terminal", enabled: true, fiberPhase: "active" as const },
		],
	},
];

function makeRpc(): RpcClient {
	return {
		request: async (method: string) => {
			if (method === "extensions.list") {
				return {
					extensions: MODULES,
					tabs: [],
					providers: [],
					components: [],
					toolViews: [],
					widgets: [],
					statusBarSegments: [],
					slots: { exact: [], prefixes: [] },
					presets: PRESETS,
				};
			}
			if (method === "plugins.packages") return { packages: [] };
			return {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function mount(variant: "list" | "cards"): Promise<{ host: HTMLElement; unmount(): Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const rpc = makeRpc();
	await act(async () => {
		root.render(
			createElement(UnifiedPluginsView, {
				rpc,
				plugins: [],
				pluginsError: null,
				onTogglePackage: () => {},
				onOpenMarketplace: () => {},
				onError: () => {},
				variant,
			}),
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

/**
 * 两个插件入口的渲染契约：能力中心只列可启停/可配置的官方插件，设置
 * 保留完整库存并在行内给出技术身份。两边同名入口不能再渲染同一份内容。
 */
describe("plugin entrances", () => {
	it("keeps the capability center to the manageable official set", async () => {
		const view = await mount("list");
		expect(view.host.textContent).toContain("Built-in plugin settings · 2");
		expect(view.host.textContent).toContain("Board");
		expect(view.host.textContent).toContain("Terminal");
		expect(view.host.textContent).not.toContain("Tool cards");
		expect(view.host.textContent).not.toContain("Chat persona");
		await view.unmount();
	});

	it("keeps the full inventory in settings with technical identity", async () => {
		const view = await mount("cards");
		// The inventory planes are collapsed overviews; the management groups
		// below them still list every builtin entry.
		expect(view.host.textContent).toContain("Session plugins · 2");
		expect(view.host.textContent).toContain("Global plugins · 2");
		expect(view.host.textContent).toContain("Built-in plugin settings · 4");
		expect(view.host.textContent).toContain("Tool cards");
		expect(view.host.textContent).toContain("Chat persona");
		expect(view.host.textContent).toContain("Read-only");
		expect(view.host.textContent).toContain("Preset-only");
		expect(view.host.textContent).toContain("Config ×1");
		await view.unmount();
	});
});
