import { beforeAll, describe, expect, test } from "bun:test";
import { ExtensionList } from "@musepi/pi-coding-agent/extensibility/extensions-center/extension-list";
import { applyPluginState } from "@musepi/pi-coding-agent/extensibility/extensions-center/state-manager";
import type { DashboardState, Extension } from "@musepi/pi-coding-agent/extensibility/extensions-center/types";
import { setLocale } from "@musepi/pi-coding-agent/i18n/index.js";
import { initTheme } from "@musepi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
	setLocale("en-US");
});

const STRIP_ANSI = /\u001b\[[0-9;]*m/g;

function plain(lines: readonly string[]): string[] {
	return lines.map(line => line.replace(STRIP_ANSI, ""));
}

function pluginExt(kind: Extension["kind"], name: string, components?: Extension["components"]): Extension {
	return {
		id: name,
		kind,
		name,
		displayName: name,
		path: "",
		source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
		state: "active",
		builtin: true,
		...(components ? { components } : {}),
		raw: {},
	};
}

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

describe("applyPluginState", () => {
	const components: Extension["components"] = [
		{ id: "whisper", name: "whisper", enabled: true, canToggle: true },
		{ id: "sensevoice", name: "sensevoice", enabled: true, canToggle: true },
	];

	test("reads component keys from disabledExtensionComponents", () => {
		const state = applyPluginState(stateWith(pluginExt("plugin-module", "stt", components)), key =>
			key === "disabledExtensionComponents" ? ["stt/whisper"] : undefined,
		);
		expect(state.extensions[0]?.components?.map(component => [component.id, component.enabled])).toEqual([
			["whisper", false],
			["sensevoice", true],
		]);
	});

	test("fails open when the component list is malformed", () => {
		const state = applyPluginState(stateWith(pluginExt("plugin-module", "stt", components)), () => "garbage");
		expect(state.extensions[0]?.components?.every(component => component.enabled)).toBe(true);
	});

	test("does not change package state when a component is disabled", () => {
		const state = applyPluginState(stateWith(pluginExt("plugin-module", "stt", components)), key =>
			key === "disabledExtensionComponents" ? ["stt/whisper"] : undefined,
		);
		expect(state.extensions[0]?.state).toBe("active");
	});
});

describe("ExtensionList component rows", () => {
	function buildVoiceList(onComponentToggle?: (extId: string, componentId: string, enabled: boolean) => void) {
		const ext = pluginExt("voice", "stt", [
			{ id: "whisper", name: "whisper", enabled: true, canToggle: true },
			{ id: "sensevoice", name: "sensevoice", enabled: false, canToggle: true },
		]);
		const list = new ExtensionList([ext], {
			masterSwitchProvider: null,
			onSelectionChange: () => {},
			onToggle: () => {},
			onComponentToggle,
		});
		list.setFocused(true);
		return { list, lines: plain(list.render(60)) };
	}

	test("renders the package and its component rows", () => {
		const { lines } = buildVoiceList();
		expect(lines[2]).toContain("Voice");
		expect(lines[3]).toContain("stt");
		expect(lines[4]).toContain("whisper");
		expect(lines[5]).toContain("sensevoice");
	});

	test("reports the package name and component ID on toggle", () => {
		const toggles: Array<[string, string, boolean]> = [];
		const { list } = buildVoiceList((extId, componentId, enabled) => toggles.push([extId, componentId, enabled]));
		list.handleClick(4);
		expect(list.getSelectedExtension()?.id).toBe("stt");
		list.handleClick(4);
		expect(toggles).toEqual([["stt", "whisper", false]]);
	});

	test("enables a disabled component", () => {
		const toggles: Array<[string, string, boolean]> = [];
		const { list } = buildVoiceList((extId, componentId, enabled) => toggles.push([extId, componentId, enabled]));
		list.handleClick(5);
		list.handleClick(5);
		expect(toggles).toEqual([["stt", "sensevoice", true]]);
	});
});
