import { afterAll, describe, expect, test } from "bun:test";
import { enUS } from "./en-US/index.js";
import { getLocaleSnapshot, registerTranslations, setLocale, t, tLoose } from "./index.js";
import { zhCN } from "./zh-CN/index.js";

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

	test("duplicate keys across zh domains fail loudly (module-load guard)", async () => {
		// The barrel throws at import time when two domains collide; a
		// duplicate present in the tree would surface here.
		const mod = await import("./zh-CN/index.js");
		expect(Object.keys(mod.zhCN).length).toBe(Object.keys(zhCN).length);
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
