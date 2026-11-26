import { afterEach, describe, expect, it } from "bun:test";
import { settingsRegistry } from "@musepi/pi-coding-agent/config/settings-registry";
import {
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	hasUi,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "@musepi/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@musepi/pi-coding-agent/modes/components/settings-defs";

/**
 * Phase 1 contract: the registry is the composed source, and with only core
 * descriptors registered it must mirror `SETTINGS_SCHEMA` exactly. TUI and the
 * daemon schema RPC read through it, so a drift here is a rendering regression.
 */
describe("settings registry mirrors the core schema", () => {
	it("keeps every core key in declaration order", () => {
		expect(settingsRegistry.keys().filter(key => key in SETTINGS_SCHEMA)).toEqual(Object.keys(SETTINGS_SCHEMA));
	});

	it("carries each descriptor's type, default, values, UI and credential flag", () => {
		for (const key of Object.keys(SETTINGS_SCHEMA)) {
			const def = SETTINGS_SCHEMA[key as SettingPath] as {
				type: string;
				default: unknown;
				values?: readonly string[];
				ui?: unknown;
				credential?: boolean;
			};
			const descriptor = settingsRegistry.get(key);
			expect(descriptor).toBeDefined();
			expect(descriptor?.type as unknown).toEqual(def.type);
			expect(descriptor?.default).toEqual(def.default);
			expect(descriptor?.values).toEqual(def.values);
			expect(descriptor?.ui as unknown).toEqual(def.ui);
			expect(descriptor?.credential as unknown).toEqual(def.credential);
		}
	});

	it("answers the accessors from the registry", () => {
		for (const key of Object.keys(SETTINGS_SCHEMA)) {
			const path = key as SettingPath;
			const def = SETTINGS_SCHEMA[path] as { type: string; default: unknown; ui?: unknown };
			expect(getType(key) as unknown).toEqual(def.type);
			expect(getDefault(path) as unknown).toEqual(def.default);
			expect(getUi(key) as unknown).toEqual(def.ui);
			expect(hasUi(key) as unknown).toEqual(def.ui !== undefined);
		}
	});

	it("keeps every tab's path list identical to the schema filter", () => {
		for (const tab of SETTING_TABS) {
			const expected = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
				path => (SETTINGS_SCHEMA[path] as { ui?: { tab?: string } }).ui?.tab === tab,
			);
			expect(getPathsForTab(tab).filter(path => path in SETTINGS_SCHEMA)).toEqual(expected);
		}
	});

	it("still composes the memory backend enum with contributed provider ids", () => {
		expect(getEnumValues("memory.backend")).toContain("musemem");
	});
});

describe("provider descriptors", () => {
	const key = "test.providerSetting";

	afterEach(() => {
		settingsRegistry.clearSource("test-provider");
	});

	it("rejects a second owner for the same key", () => {
		settingsRegistry.register(
			{ key, type: "boolean", default: false, ui: { tab: "memory", group: "MuseMem", label: key } },
			"test-provider",
		);
		expect(() =>
			settingsRegistry.register(
				{ key, type: "boolean", default: true, ui: { tab: "memory", group: "MuseMem", label: key } },
				"extension",
			),
		).toThrow(/already registered/);
	});

	it("reaches the TUI menu and disappears again when disposed", () => {
		const dispose = settingsRegistry.register(
			{
				key,
				type: "boolean",
				default: false,
				ui: { tab: "memory", group: "MuseMem", label: key, description: key },
			},
			"test-provider",
		);
		expect(getSettingsForTab("memory").some(def => def.path === (key as SettingPath))).toBe(true);
		dispose();
		expect(getSettingsForTab("memory").some(def => def.path === (key as SettingPath))).toBe(false);
	});
});

describe("daemon settings.schema reads the registry", () => {
	it("serves the same memory-tab keys, types and defaults as the core schema", async () => {
		const { Settings } = await import("@musepi/pi-coding-agent/config/settings");
		const { SettingsService } = await import("@musepi/pi-coding-agent/daemon/services/settings-service");
		const service = new SettingsService({
			cwd: () => process.cwd(),
			settings: () => Settings.isolated(),
			ensureRegistry: async () => null,
			extensionSettings: () => new Map(),
		});
		const out = (await service.schema({ tabs: ["memory"] })) as Record<
			string,
			Array<{ key: string; type: string; default: unknown; ui?: { tab?: string } }>
		>;
		const items = out.memory ?? [];
		const expected = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
			path => (SETTINGS_SCHEMA[path] as { ui?: { tab?: string } }).ui?.tab === "memory",
		);
		const coreItems = items.filter(item => item.key in SETTINGS_SCHEMA);
		expect(coreItems.map(item => item.key)).toEqual(expected);
		for (const item of coreItems) {
			const def = SETTINGS_SCHEMA[item.key as SettingPath] as { type: string; default: unknown };
			expect(item.type).toEqual(def.type);
			expect(item.default).toEqual(def.default);
		}
	});
});

describe("declarative conditions", () => {
	it("compares one setting value without a host-specific condition name", async () => {
		const { evaluateSettingCondition } = await import("@musepi/pi-coding-agent/config/settings-registry");
		const values: Record<string, unknown> = { "memory.backend": "musemem" };
		const read = (key: string) => values[key];
		expect(evaluateSettingCondition({ key: "memory.backend", equals: "musemem" }, read)).toBe(true);
		expect(evaluateSettingCondition({ key: "memory.backend", equals: "hindsight" }, read)).toBe(false);
		expect(evaluateSettingCondition({ key: "memory.backend", notEquals: "off" }, read)).toBe(true);
		expect(evaluateSettingCondition({ key: "memory.backend", in: ["musemem", "local"] }, read)).toBe(true);
		expect(evaluateSettingCondition(undefined, read)).toBe(true);
	});
});

describe("provider settings share the Settings store", () => {
	const key = "test.providerValue";
	afterEach(() => settingsRegistry.clearSource("test-provider"));

	it("reads the descriptor default until a value is written, then reads the stored value", async () => {
		const { Settings } = await import("@musepi/pi-coding-agent/config/settings");
		settingsRegistry.register(
			{ key, type: "boolean", default: true, ui: { tab: "memory", group: "MuseMem", label: key } },
			"test-provider",
		);
		const settings = Settings.isolated();
		expect(settings.getSettingValue(key)).toBe(true);
		settings.setSettingValue(key, false);
		expect(settings.getSettingValue(key)).toBe(false);
	});

	it("keeps the key while another owner still holds it", () => {
		const descriptor = { key, type: "boolean" as const, default: false };
		const first = settingsRegistry.register(descriptor, "test-provider", "owner-a");
		const second = settingsRegistry.register(descriptor, "test-provider", "owner-b");
		first();
		expect(settingsRegistry.has(key)).toBe(true);
		second();
		expect(settingsRegistry.has(key)).toBe(false);
	});
});
