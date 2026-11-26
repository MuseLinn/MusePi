import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { settingsRegistry } from "@musepi/pi-coding-agent/config/settings-registry";
import { getUi } from "@musepi/pi-coding-agent/config/settings-schema";
import type { ExtensionSetting, PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { getSettingsForTab } from "@musepi/pi-coding-agent/modes/components/settings-defs";
import { apply } from "../src/plugins/prompt/memory-musemem/index.ts";
import { createBundledPluginRuntime } from "./helpers/bundled-plugin-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

const SOURCE = "extension:test-memory-musemem";

/** Minimal host half: forward the plugin's registration into the registry. */
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
								{
									key: setting.key,
									type: setting.type,
									default: setting.default,
									ui: setting.ui,
								},
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

describe("MuseMem plugin-owned settings", () => {
	afterEach(() => settingsRegistry.clearSource(SOURCE));

	it("registers globalScope with the backend condition and the on-by-default value", () => {
		const { registered, dispose } = mountPlugin();
		try {
			expect(registered).toHaveLength(1);
			expect(registered[0]).toMatchObject({
				key: "musemem.globalScope",
				type: "boolean",
				default: true,
				ui: {
					tab: "memory",
					group: "MuseMem",
					label: "MuseMem Global Scope",
					condition: { key: "memory.backend", equals: "musemem" },
				},
			});
		} finally {
			dispose();
		}
	});

	it("reaches the TUI menu while mounted and disappears on unmount", () => {
		const { dispose } = mountPlugin();
		expect(getSettingsForTab("memory").some(def => (def.path as string) === "musemem.globalScope")).toBe(true);
		dispose();
		expect(getSettingsForTab("memory").some(def => (def.path as string) === "musemem.globalScope")).toBe(false);
	});

	it("owns the key: absent without the plugin, behaviour still on", () => {
		// The plugin owns the key now. Without it the key is unregistered, and
		// every reader uses `!== false`, so the backend keeps its on-by-default
		// behaviour instead of flipping off.
		const settings = Settings.isolated({ memory: { backend: "musemem" } } as never);
		expect(settings.getSettingValue("musemem.globalScope")).toBeUndefined();
		expect(settings.getSettingValue("musemem.globalScope") !== false).toBe(true);
		expect(getUi("musemem.globalScope")).toBeUndefined();
	});

	it("mounts through the bundled plugin runtime", async () => {
		const agentDir = await isolateAgentDirForTest("memory-musemem-plugin-");
		const bundled = createBundledPluginRuntime();
		try {
			await bundled.runtime.load(
				path.resolve(import.meta.dir, "../src/plugins/prompt/memory-musemem"),
				process.cwd(),
			);
			expect(getSettingsForTab("memory").some(def => (def.path as string) === "musemem.globalScope")).toBe(true);
		} finally {
			await bundled.dispose();
			await restoreAgentDirForTest(agentDir);
			settingsRegistry.clearSource(
				`extension:${path.resolve(import.meta.dir, "../src/plugins/prompt/memory-musemem/index.ts")}`,
			);
		}
	}, 30_000);
});
