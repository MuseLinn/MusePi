/**
 * Preset registry — a preset's composition is MOUNTED, not just declared.
 *
 * dsh 的 preset 是两件东西：注册表 + 真实挂载。这里钉的是挂载语义：
 * 行名解析、未安装组合的可见失败、重复 id 拒绝、坏 preset 不拖垮其它。
 */

import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/utils/event-bus";
import type { ResolvedMode } from "../src/presets/resolve";
import {
	type PresetEntryResolver,
	PresetRegistry,
} from "../src/extensibility/plugins/preset-registry";

const eventBus = new EventBus();
const cwd = "/virtual";

function definitionOf(id: string): ResolvedMode {
	return {
		id,
		label: id,
		extensions: undefined,
		extensionsExplicit: false,
		prompt: [],
		promptComplete: false,
		runtimeContext: true,
		settings: {},
		plugins: [],
		sources: [id],
	};
}

/** A resolver over a name → entries map. */
function resolverOf(entries: Record<string, string[]>): PresetEntryResolver {
	const map = new Map(Object.entries(entries));
	return {
		async resolveEntries() {
			return map;
		},
	};
}

/** A load stub recording what it was asked to load. */
function loaderOf(errors: Array<{ path: string; error: string }> = []) {
	const loaded: string[][] = [];
	return {
		loaded,
		async loadSessionPlugins(paths: readonly string[]) {
			loaded.push([...paths]);
			return { extensions: paths.map((p) => ({ path: p } as never)), errors, runtime: {} as never };
		},
	};
}

describe("PresetRegistry", () => {
	test("a composition row resolves to the plugin's entries and LOADS", async () => {
		// The whole point of the cordis layer: the rows in a preset file turn into
		// mounted extensions, the same pipeline a session uses.
		const loader = loaderOf();
		const registry = new PresetRegistry({
			eventBus,
			cwd,
			entryResolver: resolverOf({ "musepi-auth-hub": ["/pool/musepi-auth-hub/index.ts"] }),
			loadSessionPlugins: loader.loadSessionPlugins,
		});
		const def = definitionOf("probe");
		def.plugins = [{ name: "musepi-auth-hub" }];
		await registry.register(def, def.plugins);
		expect(loader.loaded).toHaveLength(1);
		expect(loader.loaded[0]).toEqual(["/pool/musepi-auth-hub/index.ts"]);
		expect(registry.get("probe")?.broken).toBeUndefined();
	});

	test("an uninstalled composition records WHY instead of loading nothing", async () => {
		// A silent skip would read as "the preset works but brings nothing".
		// The roster must say the row names a package that is not installed.
		const registry = new PresetRegistry({
			eventBus,
			cwd,
			entryResolver: resolverOf({}),
			loadSessionPlugins: loaderOf().loadSessionPlugins,
		});
		const def = definitionOf("probe");
		def.plugins = [{ name: "not-installed" }];
		await registry.register(def, def.plugins);
		const record = registry.get("probe");
		expect(record?.broken).toContain("not-installed");
		expect(record?.extensions).toHaveLength(0);
	});

	test("a duplicate id is refused, not resolved by order", () => {
		// The file name IS the identity; two files claiming one id is a user error
		// to surface. Silently keeping the later one would lose the first's rows.
		const registry = new PresetRegistry({
			eventBus,
			cwd,
			entryResolver: resolverOf({}),
			loadSessionPlugins: loaderOf().loadSessionPlugins,
		});
		registry.register(definitionOf("dup"), []);
		expect(() => registry.register(definitionOf("dup"), [])).toThrow(/Duplicate/);
	});

	test("a mount failure marks THIS preset broken and others stay loadable", async () => {
		// One bad preset must not cost the session every other preset — the same
		// isolation rule the plugin loader follows.
		let calls = 0;
		const failingLoader = async () => {
			calls++;
			if (calls === 1) throw new Error("mount exploded");
			return { extensions: [], errors: [], runtime: {} as never };
		};
		const registry = new PresetRegistry({
			eventBus,
			cwd,
			entryResolver: resolverOf({ "a": ["/a/index.ts"], "b": ["/b/index.ts"] }),
			loadSessionPlugins: failingLoader,
		});
		const bad = definitionOf("bad");
		bad.plugins = [{ name: "a" }];
		await registry.register(bad, bad.plugins);
		expect(registry.get("bad")?.broken).toContain("mount exploded");
		const good = definitionOf("good");
		good.plugins = [{ name: "b" }];
		await registry.register(good, good.plugins);
		expect(registry.get("good")?.broken).toBeUndefined();
	});

	test("unregister drops the record", async () => {
		const registry = new PresetRegistry({
			eventBus,
			cwd,
			entryResolver: resolverOf({}),
			loadSessionPlugins: loaderOf().loadSessionPlugins,
		});
		await registry.register(definitionOf("gone"), []);
		registry.unregister("gone");
		expect(registry.get("gone")).toBeUndefined();
	});

	test("list() covers every registered preset (roster data source)", async () => {
		const registry = new PresetRegistry({
			eventBus,
			cwd,
			entryResolver: resolverOf({}),
			loadSessionPlugins: loaderOf().loadSessionPlugins,
		});
		await registry.register(definitionOf("one"), []);
		await registry.register(definitionOf("two"), []);
		expect(registry.list().map((r) => r.id).sort()).toEqual(["one", "two"]);
	});
});
