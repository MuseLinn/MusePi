import { afterAll, describe, expect, test } from "bun:test";
import { enUS, enUSDomainCount, enUSDuplicates } from "./en-US/index.js";
import { getLocaleSnapshot, registerTranslations, setLocale, t, tLoose } from "./index.js";
import { collectDomainDuplicates } from "./merge-domains.js";
import { zhCN, zhCNDomainCount, zhCNDuplicates } from "./zh-CN/index.js";

describe("i18n maps (per-domain split)", () => {
	test("zh-CN and en-US carry the same key set", () => {
		const zh = Object.keys(zhCN).sort();
		const en = Object.keys(enUS).sort();
		expect(zh).toEqual(en);
	});

	test("every zh value is a non-empty string", () => {
		for (const value of Object.values(zhCN)) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});

	test("无跨域重复键(重复曾两次白屏 GUI — 回归即 report 非空)", () => {
		expect(zhCNDuplicates).toEqual({});
		expect(enUSDuplicates).toEqual({});
	});

	test("域文件数不缩小(防缩小守卫:扫描面收窄比漏检更糟)", () => {
		// 新增域文件时同步调高;当前 16 个域。
		expect(zhCNDomainCount).toBeGreaterThanOrEqual(16);
		expect(enUSDomainCount).toBeGreaterThanOrEqual(16);
		expect(Object.keys(zhCN).length).toBeGreaterThan(3000);
	});

	test("重复键容错:不抛错、双方域被记录(dsh fail-safe parity)", () => {
		// 合成碰撞:同一 key 落在两个域 —— 检测必须返回冲突双方,
		// 绝不抛错(模块加载期抛错 = 整个 GUI 白屏,本测试钉死该契约)。
		const report = collectDomainDuplicates("test", {
			a: { "dup.key": "A" },
			b: { "dup.key": "B", solo: "S" },
		});
		expect(report["dup.key"]).toEqual({ first: "a", second: "b" });
		expect(collectDomainDuplicates("test", { a: { x: "1" } })).toEqual({});
	});
});

describe("i18n API (split surface)", () => {
	const originalLocale = getLocaleSnapshot();

	afterAll(() => {
		setLocale(originalLocale === "zh-CN" ? "zh-CN" : "en-US");
	});

	test("t resolves zh-CN values with named params", () => {
		setLocale("zh-CN");
		expect(t("usage")).toBe("用量");
		expect(t("resets in {time}", { time: "1h" })).toBe("1h 后重置");
		expect(t("{count} sessions active", { count: 2 })).toBe("2 个会话活跃");
	});

	test("t resolves en-US values and falls back to the key", () => {
		setLocale("en-US");
		expect(t("usage")).toBe("Usage");
		expect(t("resets in {time}", { time: "1h" })).toBe("Resets in 1h");
	});

	test("registerTranslations overlays new + existing keys for the locale", () => {
		setLocale("zh-CN");
		registerTranslations("zh-CN", {
			"plugin.custom.greeting": "插件你好",
			usage: "自定义用量",
		});
		expect(tLoose("plugin.custom.greeting")).toBe("插件你好");
		expect(t("usage")).toBe("自定义用量");
		// Other locale untouched.
		setLocale("en-US");
		expect(t("usage")).toBe("Usage");
	});

	test("registerTranslations adds a brand-new locale", () => {
		registerTranslations("fr-FR", { "plugin.custom.greeting": "Bonjour" });
		setLocale("fr-FR");
		expect(tLoose("plugin.custom.greeting")).toBe("Bonjour");
		// Fallback for unregistered keys in the new locale.
		expect(t("usage")).toBe("usage");
		setLocale("en-US");
	});
});
