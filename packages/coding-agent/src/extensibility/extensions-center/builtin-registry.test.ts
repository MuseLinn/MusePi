import { describe, expect, it } from "bun:test";
import { TOOL_RENDER_CARD_TOOLS } from "../../../../client-core/src/tool-render/card-tools";
import { BUNDLED_SKILL_NAMES } from "../../bundled-skills/index.ts";
import { SETTINGS_SCHEMA } from "../../config/settings-schema.ts";
import { getBuiltinThemes } from "../../modes/theme/loader.ts";
import {
	annotateBuiltinExtensions,
	BUILTIN_EXTENSIONS,
	builtinExtensionEntries,
	builtinMirrorDisabled,
	findBuiltinDef,
} from "./builtin-registry";
import { buildProviderTabs, buildSidebarTree, filterByProvider } from "./state-manager";
import type { Extension } from "./types";

/** Desktop shell extension (dsh-desktop parity): the Electron shell is a
 *  first-class extension — extensions.list reports it, and setEnabled toggles
 *  it (mirrored on shell.enabled). The builtin registry is its home. */
describe("builtin registry — desktop shell", () => {
	it("declares the desktop-shell builtin (kind desktop-shell, id desktop-shell:shell)", () => {
		const def = BUILTIN_EXTENSIONS.find(d => d.kind === "desktop-shell");
		expect(def).toBeDefined();
		expect(def?.name).toBe("shell");
		expect(def?.displayName).toContain("Shell");
		expect(def?.settingsMirror?.key).toBe("shell.enabled");
	});

	it("emits an active desktop-shell entry by default", () => {
		const entries = builtinExtensionEntries(new Set());
		const shell = entries.find(e => e.id === "desktop-shell:shell");
		expect(shell).toBeDefined();
		expect(shell?.kind).toBe("desktop-shell");
		expect(shell?.state).toBe("active");
		expect(shell?.path).toBe(""); // read-only builtin, no file to reload
	});

	it("disables the shell when its id is in disabledExtensions", () => {
		const entries = builtinExtensionEntries(new Set(["desktop-shell:shell"]));
		const shell = entries.find(e => e.id === "desktop-shell:shell");
		expect(shell?.state).toBe("disabled");
		expect(shell?.disabledReason).toBe("item-disabled");
	});
});

describe("builtin registry — M2.1 登记完整性(清单来源交集)", () => {
	it("bundled skills:每一个内置技能都有 annotate 定义,且注册表不为它们产生重复行", () => {
		// Failure mode: 新增 bundled skill 只改安装清单不登记 —— 扩展中心
		// 少一枚"内置"标注,登记完整性 silently 破功。
		const skillDefs = BUILTIN_EXTENSIONS.filter(d => d.kind === "skill");
		expect(skillDefs.map(d => d.name).sort()).toEqual([...BUNDLED_SKILL_NAMES].sort());
		expect(skillDefs.every(d => d.annotate)).toBe(true);
		const emitted = builtinExtensionEntries(new Set()).filter(e => e.kind === "skill");
		expect(emitted).toHaveLength(0);
	});

	it("magic keywords:三个关键词全部登记,且镜像键是 settings schema 的真实键", () => {
		// Failure mode: setEnabled 写了不存在的设置键 —— 开关无声失效。
		const kwDefs = BUILTIN_EXTENSIONS.filter(d => d.kind === "magic-keyword");
		expect(kwDefs.map(d => d.name).sort()).toEqual(["orchestrate", "ultrathink", "workflow"]);
		for (const def of kwDefs) {
			const key = def.settingsMirror?.key;
			expect(key).toBeDefined();
			expect(Object.keys(SETTINGS_SCHEMA)).toContain(key as string);
		}
	});

	it("theme pack:注册表内的主题清单与主题加载器完全一致", () => {
		// Failure mode: 主题增删后注册表漂移 —— 扩展中心 advertised 清单失真。
		const themeDef = BUILTIN_EXTENSIONS.find(d => d.kind === "theme");
		expect(themeDef?.readonly).toBe(true);
		const raw = themeDef?.raw as { themes: string[] };
		expect([...raw.themes].sort()).toEqual(Object.keys(getBuiltinThemes()).sort());
	});

	it("tool-render pack:注册表快照与 client-core 权威清单一致", () => {
		// Failure mode: client-core 新增卡片渲染器而注册表快照未跟进 ——
		// 插件管理里的卡片工具清单缺项。
		const packDef = BUILTIN_EXTENSIONS.find(d => d.kind === "tool-render");
		expect(packDef?.readonly).toBe(true);
		const raw = packDef?.raw as { tools: string[] };
		expect([...raw.tools].sort()).toEqual([...TOOL_RENDER_CARD_TOOLS].sort());
	});
});

describe("builtin registry — provider 口径与标注", () => {
	it("注册表条目以 musepi-extensions provider 的 builtin 项呈现(native 语义不扩大)", () => {
		for (const entry of builtinExtensionEntries(new Set())) {
			expect(entry.source.provider).toBe("musepi-extensions");
			expect(entry.source.level).toBe("native");
			expect(entry.builtin).toBe(true);
		}
	});

	it("annotateBuiltinExtensions 给同 id 扫描行打 builtin 标记,其余行不动", () => {
		// Failure mode: 安装后的 bundled skill 在列表里丢失"内置"身份。
		const scanned: Extension[] = [
			{
				id: "skill:musepi-help",
				kind: "skill",
				name: "musepi-help",
				displayName: "musepi-help",
				path: "/home/u/.musepi/agent/skills/musepi-help/SKILL.md",
				source: { provider: "native", providerName: "MusePi", level: "user" },
				state: "active",
				raw: {},
			},
			{
				id: "skill:my-own",
				kind: "skill",
				name: "my-own",
				displayName: "my-own",
				path: "/p/skills/my-own/SKILL.md",
				source: { provider: "native", providerName: "MusePi", level: "project" },
				state: "active",
				raw: {},
			},
		];
		const annotated = annotateBuiltinExtensions(scanned);
		expect(annotated[0]?.builtin).toBe(true);
		expect(annotated[1]?.builtin).toBeUndefined();
	});
});

describe("builtin registry — settingsMirror 禁用判定", () => {
	it("设置值 === off 即禁用,未设置(默认启用)视为启用", () => {
		// Failure mode: daemon/TUI 对同一设置读出相反 state —— 开关显示与实际行为漂移。
		const style = findBuiltinDef("style:task-card-swarm");
		expect(style).toBeDefined();
		expect(builtinMirrorDisabled(style!, () => "classic")).toBe(true);
		expect(builtinMirrorDisabled(style!, () => "swarm")).toBe(false);
		expect(builtinMirrorDisabled(style!, () => undefined)).toBe(false);

		const shell = findBuiltinDef("desktop-shell:shell");
		expect(builtinMirrorDisabled(shell!, () => false)).toBe(true);
		expect(builtinMirrorDisabled(shell!, () => undefined)).toBe(false);

		const kw = findBuiltinDef("magic-keyword:ultrathink");
		expect(builtinMirrorDisabled(kw!, () => false)).toBe(true);
		expect(builtinMirrorDisabled(kw!, () => true)).toBe(false);
	});
});

describe("provider tab 可见性(M2.1 去 skip-native)", () => {
	const fixture: Extension[] = [
		{
			id: "skill:musepi-help",
			kind: "skill",
			name: "musepi-help",
			displayName: "musepi-help",
			path: "",
			source: { provider: "native", providerName: "MusePi", level: "user" },
			state: "active",
			builtin: true,
			raw: {},
		},
		{
			id: "magic-keyword:ultrathink",
			kind: "magic-keyword",
			name: "ultrathink",
			displayName: "Ultrathink Keyword",
			path: "",
			source: { provider: "musepi-extensions", providerName: "MusePi Extensions", level: "native" },
			state: "active",
			builtin: true,
			raw: {},
		},
	];

	it("buildProviderTabs 产出 native tab 且计数正确(回归即重新隐藏内置项)", () => {
		const tabs = buildProviderTabs(fixture);
		const nativeTab = tabs.find(t => t.id === "native");
		expect(nativeTab).toBeDefined();
		expect(nativeTab?.count).toBe(1);
	});

	it("buildSidebarTree 为 native provider 建节点", () => {
		const tree = buildSidebarTree(fixture);
		expect(tree.some(n => n.id === "native")).toBe(true);
	});

	it("filterByProvider(native) 返回 native 条目", () => {
		const filtered = filterByProvider(fixture, "native");
		expect(filtered.map(e => e.id)).toEqual(["skill:musepi-help"]);
	});
});
