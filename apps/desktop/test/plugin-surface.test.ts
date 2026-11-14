import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import {
	manageablePluginCount,
	officialPluginsFor,
	type PluginPackageEntry,
	pluginSurface,
} from "../src/components/UnifiedPluginsView";
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

/**
 * 两个插件入口的层级契约：能力中心只列用户能启停或配置的官方插件，
 * 设置保留完整库存（只读单元与预设专用 persona 只在这里出现）。
 * 判定只吃清单事实，不依赖第二份插件名单。
 */
describe("plugin surface layering", () => {
	const manageable = builtin({ id: "musepi-board", name: "board" });
	const configurable = builtin({
		id: "musepi-terminal",
		name: "terminal",
		readonly: true,
		config: [{ key: "backend", type: "string", label: "Backend" }],
	});
	const readonlyPack = builtin({ id: "musepi-tool-cards", name: "tool-cards", readonly: true });
	const presetPersona = builtin({ id: "musepi-preset-chat", name: "preset-chat", presetOnly: true });
	const installed = {
		...builtin({ id: "third-party", name: "third-party" }),
		builtin: false,
		source: { provider: "musepi-plugins", providerName: "Plugins", level: "user" as const },
	};

	it("keeps read-only packs and preset-only personas out of the capability center", () => {
		expect(pluginSurface(manageable)).toBe("manage");
		expect(pluginSurface(configurable)).toBe("manage");
		expect(pluginSurface(readonlyPack)).toBe("inventory");
		expect(pluginSurface(presetPersona)).toBe("inventory");
		// 用户安装的模块不属于内置库存，永远可管理。
		expect(pluginSurface(installed)).toBe("manage");
	});

	it("lists a different official set per entrance", () => {
		const modules = [manageable, configurable, readonlyPack, presetPersona, installed];
		expect(officialPluginsFor("list", modules).map(e => e.name)).toEqual(["board", "terminal"]);
		expect(officialPluginsFor("cards", modules).map(e => e.name)).toEqual([
			"board",
			"terminal",
			"tool-cards",
			"preset-chat",
		]);
	});

	it("counts what the pane can show, without double-counting packaged modules", () => {
		const pkg = {
			name: "foo",
			version: "1.0.0",
			path: "/plugins/foo",
			scope: "user",
			enabled: true,
			description: null,
			icon: null,
			tools: 0,
			commands: 0,
			handlers: 0,
		} satisfies PluginPackageEntry;
		const packagedModule = {
			...builtin({ id: "foo-index", name: "foo" }),
			builtin: false,
			path: "/plugins/foo/index.ts",
			source: { provider: "musepi-plugins", providerName: "Plugins", level: "user" as const },
		};
		const modules = [manageable, configurable, readonlyPack, presetPersona, installed, packagedModule];

		// official manage (2) + package (1) + standalone user module (1);
		// the module inside the package belongs to its package row.
		expect(manageablePluginCount(modules, [pkg], "list")).toBe(4);
	});
});
