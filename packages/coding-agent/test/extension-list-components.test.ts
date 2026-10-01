import { beforeAll, describe, expect, test } from "bun:test";
import { componentDenyTarget } from "@musepi/pi-coding-agent/extensibility/extensions-center/builtin-registry";
import { ExtensionList } from "@musepi/pi-coding-agent/extensibility/extensions-center/extension-list";
import { applyBuiltinMirrorState } from "@musepi/pi-coding-agent/extensibility/extensions-center/state-manager";
import type { DashboardState, Extension } from "@musepi/pi-coding-agent/extensibility/extensions-center/types";
import { setLocale } from "@musepi/pi-coding-agent/i18n/index.js";
import { initTheme } from "@musepi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
	// Pin locale so rendered kind labels are deterministic (en = pass-through keys).
	setLocale("en-US");
});

const STRIP_ANSI = /\[[0-9;]*m/g;

function plain(lines: readonly string[]): string[] {
	return lines.map(l => l.replace(STRIP_ANSI, ""));
}

function builtinExt(kind: Extension["kind"], name: string, components?: Extension["components"]): Extension {
	return {
		id: `${kind}:${name}`,
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

describe("componentDenyTarget — deny 通道 → 隐藏设置键映射", () => {
	test("tool 通道写 tools.disabled,组件 id 原样", () => {
		expect(componentDenyTarget("tool", "read")).toEqual({ key: "tools.disabled", id: "read" });
	});
	test("stt/tts 引擎通道写 voice.disabledEngines,带前缀", () => {
		expect(componentDenyTarget("stt-engine", "whisper")).toEqual({ key: "voice.disabledEngines", id: "stt:whisper" });
		expect(componentDenyTarget("tts-engine", "kokoro")).toEqual({ key: "voice.disabledEngines", id: "tts:kokoro" });
	});
	test("terminal/browser/file 后端通道写各自 disabledBackends", () => {
		expect(componentDenyTarget("terminal-backend", "bun-pty")).toEqual({
			key: "terminal.disabledBackends",
			id: "bun-pty",
		});
		expect(componentDenyTarget("browser-backend", "launch")).toEqual({
			key: "browser.disabledBackends",
			id: "launch",
		});
		expect(componentDenyTarget("file-backend", "index")).toEqual({ key: "file.disabledBackends", id: "index" });
	});
});

describe("applyBuiltinMirrorState — TUI 组件状态标注", () => {
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

	test("voice.disabledEngines 名单内的组件标注为停用(TUI 独立进程无 daemon 标注)", () => {
		const ext = builtinExt("voice", "stt");
		const state = applyBuiltinMirrorState(stateWith(ext), () => ["stt:whisper"]);
		const components = state.extensions[0]?.components;
		expect(components?.map(c => [c.id, c.enabled])).toEqual([
			["whisper", false],
			["sensevoice", true],
			["parakeet", true],
		]);
	});

	test("名单值不可解析(非数组)按启用处理(fail-open,与 daemon 同口径)", () => {
		const ext = builtinExt("terminal", "terminal");
		const state = applyBuiltinMirrorState(stateWith(ext), () => "garbage");
		expect(state.extensions[0]?.components?.every(c => c.enabled)).toBe(true);
	});

	test("settingsMirror 总开关判定不受组件标注影响", () => {
		const ext = builtinExt("voice", "stt");
		const state = applyBuiltinMirrorState(stateWith(ext), key => (key === "stt.enabled" ? false : []));
		expect(state.extensions[0]?.state).toBe("disabled");
		expect(state.extensions[0]?.components?.every(c => c.enabled)).toBe(true);
	});
});

describe("ExtensionList 组件子行", () => {
	/**
	 * ALL view with one voice builtin (3 components): lines are
	 * 0 search, 1 blank, 2 kind header, 3 extension, 4-6 components.
	 */
	function buildVoiceList(onComponentToggle?: (extId: string, componentId: string, enabled: boolean) => void) {
		const ext = builtinExt("voice", "stt", [
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
		const lines = plain(list.render(60));
		return { list, lines };
	}

	test("ALL 视图渲染 voice kind 头与组件子行(回归:子系统 kind 曾被 kindOrder 丢弃)", () => {
		const { lines } = buildVoiceList();
		expect(lines[2]).toContain("Voice");
		expect(lines[2]).toContain("(1)");
		expect(lines[3]).toContain("stt");
		expect(lines[4]).toContain("whisper");
		expect(lines[5]).toContain("sensevoice");
	});

	test("点击已选中的组件子行触发 onComponentToggle(父 id + 组件 id + 新状态)", () => {
		const toggles: Array<[string, string, boolean]> = [];
		const { list } = buildVoiceList((extId, componentId, enabled) => toggles.push([extId, componentId, enabled]));
		// whisper row (line 4): first click selects the component row (parent shown in inspector).
		list.handleClick(4);
		expect(list.getSelectedExtension()?.id).toBe("voice:stt");
		list.handleClick(4);
		expect(toggles).toEqual([["voice:stt", "whisper", false]]);
	});

	test("停用的组件被开启时回调 enabled=true", () => {
		const toggles: Array<[string, string, boolean]> = [];
		const { list } = buildVoiceList((extId, componentId, enabled) => toggles.push([extId, componentId, enabled]));
		list.handleClick(5); // sensevoice, currently disabled
		list.handleClick(5);
		expect(toggles).toEqual([["voice:stt", "sensevoice", true]]);
	});
});
