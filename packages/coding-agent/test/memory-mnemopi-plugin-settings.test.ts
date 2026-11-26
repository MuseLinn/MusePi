import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { settingsRegistry } from "@musepi/pi-coding-agent/config/settings-registry";
import { getUi } from "@musepi/pi-coding-agent/config/settings-schema";
import type { ExtensionSetting, PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { getSettingsForTab } from "@musepi/pi-coding-agent/modes/components/settings-defs";
import { apply } from "../src/plugins/prompt/memory-mnemopi/index.ts";
import { createBundledPluginRuntime } from "./helpers/bundled-plugin-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

const SOURCE = "extension:test-memory-mnemopi";

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

describe("Mnemopi plugin-owned settings", () => {
	afterEach(() => settingsRegistry.clearSource(SOURCE));

	it("registers every UI row with the Mnemopi backend condition", () => {
		const { registered, dispose } = mountPlugin();
		try {
			expect(registered).toHaveLength(17);
			const scoping = registered.find(setting => setting.key === "mnemopi.scoping");
			expect(scoping).toMatchObject({
				type: "enum",
				default: "per-project",
				ui: { tab: "memory", group: "Mnemopi", condition: { key: "memory.backend", equals: "mnemopi" } },
			});
			expect(registered.some(setting => setting.key === "mnemopi.dbPath")).toBe(true);
			expect(registered.some(setting => setting.key === "mnemopi.debug")).toBe(false);
		} finally {
			dispose();
		}
	});

	it("shows the rows in the TUI menu only while mounted", () => {
		const { dispose } = mountPlugin();
		expect(getSettingsForTab("memory").some(def => (def.path as string) === "mnemopi.scoping")).toBe(true);
		dispose();
		expect(getSettingsForTab("memory").some(def => (def.path as string) === "mnemopi.scoping")).toBe(false);
	});

	it("keeps the package defaults while the plugin is absent", async () => {
		const settings = Settings.isolated();
		const { MNEMOPI_SETTING_DEFAULTS, readMnemopiSetting } = await import("../src/mnemopi/settings");
		expect(readMnemopiSetting(settings, "mnemopi.scoping")).toBe("per-project");
		expect(readMnemopiSetting(settings, "mnemopi.retainEveryNTurns")).toBe(4);
		expect(MNEMOPI_SETTING_DEFAULTS["mnemopi.llmMode"]).toBe("smol");
		expect(getUi("mnemopi.scoping")).toBeUndefined();
	});

	it("mounts through the bundled plugin runtime", async () => {
		const agentDir = await isolateAgentDirForTest("memory-mnemopi-plugin-");
		const bundled = createBundledPluginRuntime();
		try {
			await bundled.runtime.load(
				path.resolve(import.meta.dir, "../src/plugins/prompt/memory-mnemopi"),
				process.cwd(),
			);
			expect(getSettingsForTab("memory").some(def => (def.path as string) === "mnemopi.scoping")).toBe(true);
		} finally {
			await bundled.dispose();
			await restoreAgentDirForTest(agentDir);
			settingsRegistry.clearSource(
				`extension:${path.resolve(import.meta.dir, "../src/plugins/prompt/memory-mnemopi/index.ts")}`,
			);
		}
	}, 30_000);
});
