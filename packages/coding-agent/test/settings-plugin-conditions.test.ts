import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getDefault, Settings } from "@musepi/pi-coding-agent/config/settings";
import { applyBuiltinMirrorState } from "@musepi/pi-coding-agent/extensibility/extensions-center/state-manager";
import type { DashboardState, Extension } from "@musepi/pi-coding-agent/extensibility/extensions-center/types";
import { getSettingDef } from "@musepi/pi-coding-agent/modes/components/settings-defs";

let settings: Settings;

beforeAll(async () => {
	settings = await Settings.init({ inMemory: true });
});

afterEach(() => {
	// 每个用例前重新落默认,避免条件谓词状态泄漏(单例跨用例存活)。
	for (const key of ["stt.enabled", "speech.enabled", "browser.enabled", "computer.enabled"] as const) {
		settings.set(key, getDefault(key));
	}
});

describe("插件归属设置随插件停用隐藏(TUI /settings)", () => {
	test("stt.* 配置键带 sttPluginEnabled 条件,谓词跟随 stt.enabled", () => {
		const def = getSettingDef("stt.modelName");
		expect(def?.condition).toBeDefined();
		settings.set("stt.enabled", true);
		expect(def?.condition?.()).toBe(true);
		settings.set("stt.enabled", false);
		expect(def?.condition?.()).toBe(false);
	});

	test("总开关本身(stt.enabled)不受条件门支配,停用后仍可重新启用", () => {
		expect(getSettingDef("stt.enabled")?.condition).toBeUndefined();
	});

	test("stt.language 补上 ui 块(此前插件 config 唯一没有 /settings 入口的键)", () => {
		const def = getSettingDef("stt.language");
		expect(def).toBeDefined();
		expect(def?.condition).toBeDefined();
	});

	test("tts.* 与 speech.* 配置键带 ttsPluginEnabled 条件(speech.enabled 门)", () => {
		settings.set("speech.enabled", false);
		expect(getSettingDef("tts.autoRead")?.condition?.()).toBe(false);
		expect(getSettingDef("tts.localModel")?.condition?.()).toBe(false);
		expect(getSettingDef("speech.voice")?.condition?.()).toBe(false);
		settings.set("speech.enabled", true);
		expect(getSettingDef("tts.autoRead")?.condition?.()).toBe(true);
		// speech.enabled 是 TTS 插件总开关,保持可见。
		expect(getSettingDef("speech.enabled")?.condition).toBeUndefined();
	});

	test("browserPluginEnabled fail-open:未设置(默认启用)即可见", () => {
		expect(getSettingDef("browser.headless")?.condition?.()).toBe(true);
		settings.set("browser.enabled", false);
		expect(getSettingDef("browser.headless")?.condition?.()).toBe(false);
		expect(getSettingDef("browser.cdpUrl")?.condition?.()).toBe(false);
	});

	test("computerPluginEnabled 随 unsetDisabled 语义:未设置即隐藏(默认停用)", () => {
		expect(getSettingDef("computer.display")?.condition?.()).toBe(false);
		settings.set("computer.enabled", true);
		expect(getSettingDef("computer.display")?.condition?.()).toBe(true);
		// number 且无 options 的键(如 maxWidth)按既有约定不进面板,不受插件状态影响。
		expect(getSettingDef("computer.maxWidth")).toBeUndefined();
	});
});

describe("applyBuiltinMirrorState — TUI 配置面标注", () => {
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

	test("builtin 单元的 configValues 从设置直读(检视面配置段的数据源)", () => {
		const ext: Extension = {
			id: "voice:stt",
			kind: "voice",
			name: "stt",
			displayName: "stt",
			path: "",
			source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
			state: "active",
			raw: {},
		};
		const values: Record<string, unknown> = { "stt.enabled": true, "stt.vadEndMs": 900 };
		const state = applyBuiltinMirrorState(stateWith(ext), key => values[key]);
		expect(state.extensions[0]?.configValues?.["stt.vadEndMs"]).toBe(900);
	});
});
