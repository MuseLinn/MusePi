import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { settingsRegistry } from "@musepi/pi-coding-agent/config/settings-registry";
import { getUi } from "@musepi/pi-coding-agent/config/settings-schema";
import type { ExtensionSetting, PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { getSettingsForTab } from "@musepi/pi-coding-agent/modes/components/settings-defs";
import { apply } from "../src/plugins/prompt/memory-hindsight/index.ts";
import { createBundledPluginRuntime } from "./helpers/bundled-plugin-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

const SOURCE = "extension:test-memory-hindsight";

function mountPlugin(): { registered: ExtensionSetting[]; dispose: () => void } {
	const registered: ExtensionSetting[] = [];
	const disposers: Array<() => void> = [];
	const ctx = {
		settings: {
			register(setting: ExtensionSetting): void {
				registered.push(setting);
				disposers.push(
					settingsRegistry.has(setting.key)
						? settingsRegistry.registerUi(setting.key, setting.ui, SOURCE, "test-owner")
						: settingsRegistry.register(
								{ key: setting.key, type: setting.type, default: setting.default, ui: setting.ui },
								SOURCE,
								"test-owner",
							),
				);
			},
		},
		memory: { registerBackendProvider: () => () => {} },
	} as unknown as PluginAPI;
	apply(ctx);
	return {
		registered,
		dispose: () => {
			for (const dispose of disposers) dispose();
		},
	};
}

describe("Hindsight plugin-owned settings", () => {
	afterEach(() => settingsRegistry.clearSource(SOURCE));

	it("registers the ten UI rows with the Hindsight backend condition", () => {
		const { registered, dispose } = mountPlugin();
		try {
			expect(registered).toHaveLength(10);
			expect(registered.find(setting => setting.key === "hindsight.scoping")).toMatchObject({
				type: "enum",
				default: "per-project-tagged",
				ui: { tab: "memory", group: "Hindsight", condition: { key: "memory.backend", equals: "hindsight" } },
			});
			expect(registered.some(setting => setting.key === "hindsight.apiToken")).toBe(true);
			expect(registered.some(setting => setting.key === "hindsight.debug")).toBe(false);
		} finally {
			dispose();
		}
	});

	it("shows the rows in the TUI menu only while mounted", () => {
		const { dispose } = mountPlugin();
		expect(getSettingsForTab("memory").some(def => (def.path as string) === "hindsight.scoping")).toBe(true);
		dispose();
		expect(getSettingsForTab("memory").some(def => (def.path as string) === "hindsight.scoping")).toBe(false);
	});

	it("keeps the package defaults while the plugin is absent", async () => {
		const settings = Settings.isolated();
		const { HINDSIGHT_SETTING_DEFAULTS, readHindsightSetting } = await import("../src/hindsight/settings");
		expect(readHindsightSetting(settings, "hindsight.scoping")).toBe("per-project-tagged");
		expect(readHindsightSetting(settings, "hindsight.autoRecall")).toBe(true);
		expect(HINDSIGHT_SETTING_DEFAULTS["hindsight.recallTypes"]).toEqual(["world", "experience"]);
		expect(getUi("hindsight.scoping")).toBeUndefined();
	});

	it("mounts through the bundled plugin runtime", async () => {
		const agentDir = await isolateAgentDirForTest("memory-hindsight-plugin-");
		const bundled = createBundledPluginRuntime();
		try {
			await bundled.runtime.load(
				path.resolve(import.meta.dir, "../src/plugins/prompt/memory-hindsight"),
				process.cwd(),
			);
			expect(getSettingsForTab("memory").some(def => (def.path as string) === "hindsight.scoping")).toBe(true);
		} finally {
			await bundled.dispose();
			await restoreAgentDirForTest(agentDir);
			settingsRegistry.clearSource(
				`extension:${path.resolve(import.meta.dir, "../src/plugins/prompt/memory-hindsight/index.ts")}`,
			);
		}
	}, 30_000);
});
