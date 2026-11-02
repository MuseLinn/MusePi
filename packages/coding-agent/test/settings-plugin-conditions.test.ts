import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { applyPluginState } from "@musepi/pi-coding-agent/extensibility/extensions-center/state-manager";
import type { DashboardState, Extension } from "@musepi/pi-coding-agent/extensibility/extensions-center/types";
import { getSettingDef } from "@musepi/pi-coding-agent/modes/components/settings-defs";

let settings: Settings;

beforeAll(async () => {
	settings = await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.set("disabledExtensions", []);
});

describe("plugin-owned settings visibility", () => {
	test("stt settings follow only the stt package state", () => {
		const def = getSettingDef("stt.modelName");
		expect(def?.condition).toBeDefined();
		expect(def?.condition?.()).toBe(true);
		settings.set("stt.enabled", false);
		expect(def?.condition?.()).toBe(true);
		settings.set("disabledExtensions", ["stt"]);
		expect(def?.condition?.()).toBe(false);
	});

	test("the domain switch remains visible independently of package state", () => {
		expect(getSettingDef("stt.enabled")?.condition).toBeUndefined();
	});

	test("stt language has the same package condition", () => {
		expect(getSettingDef("stt.language")?.condition).toBeDefined();
	});

	test("tts settings follow only the tts package state", () => {
		settings.set("speech.enabled", false);
		expect(getSettingDef("tts.autoRead")?.condition?.()).toBe(true);
		settings.set("disabledExtensions", ["tts"]);
		expect(getSettingDef("tts.autoRead")?.condition?.()).toBe(false);
		expect(getSettingDef("tts.localModel")?.condition?.()).toBe(false);
		expect(getSettingDef("speech.voice")?.condition?.()).toBe(false);
		expect(getSettingDef("speech.enabled")?.condition).toBeUndefined();
	});

	test("browser settings follow the browser package", () => {
		expect(getSettingDef("browser.headless")?.condition?.()).toBe(true);
		settings.set("disabledExtensions", ["browser"]);
		expect(getSettingDef("browser.headless")?.condition?.()).toBe(false);
		expect(getSettingDef("browser.cdpUrl")?.condition?.()).toBe(false);
	});

	test("computer settings follow the computer package", () => {
		expect(getSettingDef("computer.display")?.condition?.()).toBe(true);
		settings.set("disabledExtensions", ["computer"]);
		expect(getSettingDef("computer.display")?.condition?.()).toBe(false);
		expect(getSettingDef("computer.maxWidth")).toBeUndefined();
	});
});

describe("applyPluginState configuration", () => {
	function stateWith(ext: Extension): DashboardState {
		return {
			tabs: [],
			activeTabIndex: 0,
			extensions: [ext],
			tabFiltered: [ext],
			searchFiltered: [ext],
			searchQuery: "",
			listIndex: 0,
			scrollOffset: 0,
			selected: ext,
		};
	}

	test("reads settings-backed config values without changing package state", () => {
		const ext: Extension = {
			id: "stt",
			kind: "plugin-module",
			name: "stt",
			displayName: "语音输入（STT）",
			path: "",
			source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
			state: "active",
			host: { configStorage: "settings" },
			config: [
				{
					key: "stt.vadEndMs",
					type: "number",
					default: 700,
					label: "静音结束时长",
					description: "连续静音达到该毫秒数后结束录音。",
				},
			],
			raw: {},
		};
		const state = applyPluginState(stateWith(ext), key => (key === "stt.vadEndMs" ? 900 : undefined));
		expect(state.extensions[0]?.configValues?.["stt.vadEndMs"]).toBe(900);
		expect(state.extensions[0]?.state).toBe("active");
	});
});
