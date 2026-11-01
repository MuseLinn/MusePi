import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import { PresetRegistry } from "../src/extensibility/plugins/preset-registry";
import type { ResolvedMode } from "../src/presets/resolve";
import { EventBus } from "../src/utils/event-bus";

declare global {
	var __presetRegistryCleanup: boolean | undefined;
}

let cwd: string;
const eventBus = new EventBus();

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-preset-registry-"));
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

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

function entry(
	name: string,
	source = `export function apply(pi) { pi.registerTool({ name: "preset_tool", description: "preset", parameters: {}, execute: async () => ({ content: [] }) }); }`,
): string {
	const file = path.join(cwd, `${name}.js`);
	fs.writeFileSync(file, source, "utf8");
	return file;
}

function registryOf(entries: Record<string, string>): PresetRegistry {
	return new PresetRegistry({
		eventBus,
		cwd,
		runtime: new ExtensionRuntime(),
		readConfig: async () => ({ fields: [], values: {} }),
		entryResolver: {
			resolveEntries: async () => new Map(Object.entries(entries).map(([name, file]) => [name, [file]])),
		},
	});
}

describe("PresetRegistry", () => {
	test("mounts composition rows as Cordis plugins with real registrations", async () => {
		const registry = registryOf({ "musepi-auth-hub": entry("auth") });
		const def = definitionOf("probe");
		def.plugins = [{ name: "musepi-auth-hub" }];
		await registry.register(def, def.plugins);
		expect(registry.get("probe")?.broken).toBeUndefined();
		expect([...registry.get("probe")!.extensions[0]!.tools.keys()]).toEqual(["preset_tool"]);
		await registry.dispose();
	});

	test("records a missing package instead of silently reporting success", async () => {
		const registry = registryOf({});
		const def = definitionOf("probe");
		def.plugins = [{ name: "not-installed" }];
		await registry.register(def, def.plugins);
		expect(registry.get("probe")?.broken).toContain("not-installed");
		expect(registry.get("probe")?.extensions).toHaveLength(0);
	});

	test("rejects duplicate ids", async () => {
		const registry = registryOf({});
		await registry.register(definitionOf("dup"), []);
		await expect(registry.register(definitionOf("dup"), [])).rejects.toThrow(/Duplicate/);
	});

	test("contains one preset's failure while another still mounts", async () => {
		const registry = registryOf({ a: entry("bad", "export {"), b: entry("good") });
		const bad = definitionOf("bad");
		bad.plugins = [{ name: "a" }];
		await registry.register(bad, bad.plugins);
		expect(registry.get("bad")?.broken).toBeTruthy();
		const good = definitionOf("good");
		good.plugins = [{ name: "b" }];
		await registry.register(good, good.plugins);
		expect(registry.get("good")?.broken).toBeUndefined();
		await registry.dispose();
	});

	test("unregister disposes the preset fiber and removes its roster record", async () => {
		const registry = registryOf({
			plugin: entry(
				"effect",
				`export function apply(pi) { pi.effect(() => { globalThis.__presetRegistryCleanup = true; }); }`,
			),
		});
		const def = definitionOf("gone");
		def.plugins = [{ name: "plugin" }];
		await registry.register(def, def.plugins);
		await registry.unregister("gone");
		expect(registry.get("gone")).toBeUndefined();
		expect(globalThis.__presetRegistryCleanup).toBe(true);
		delete globalThis.__presetRegistryCleanup;
	});

	test("lists every registered preset", async () => {
		const registry = registryOf({});
		await registry.register(definitionOf("one"), []);
		await registry.register(definitionOf("two"), []);
		expect(
			registry
				.list()
				.map(record => record.id)
				.sort(),
		).toEqual(["one", "two"]);
		await registry.dispose();
	});
});
