import { afterAll, describe, expect, test } from "bun:test";
import { getLocale, registerTranslations, setLocale, t } from "../src/i18n/index.js";

const INITIAL = getLocale();

afterAll(() => setLocale(INITIAL));

describe("TUI i18n (per-domain split)", () => {
	test("zh-CN map resolves with positional params", () => {
		setLocale("zh-CN");
		expect(t("Sign in")).toBe("登录");
		expect(t("Session {0}", "42")).toBe("Session 42");
	});

	test("missing key falls back to the key itself", () => {
		expect(t("this key does not exist anywhere")).toBe("this key does not exist anywhere");
	});

	test("zh-CN-b5 falls back to the zh-CN map", () => {
		setLocale("zh-CN-b5");
		expect(t("Sign in")).toBe("登录");
	});

	test("registerTranslations overlays new + existing keys", () => {
		setLocale("zh-CN");
		registerTranslations("zh-CN", {
			"plugin.custom.greeting": "插件你好",
			"Sign in": "自定义登录",
		});
		expect(t("plugin.custom.greeting")).toBe("插件你好");
		expect(t("Sign in")).toBe("自定义登录");
		// Other locale untouched (falls back to pass-through).
		setLocale("en-US");
		expect(t("plugin.custom.greeting")).toBe("plugin.custom.greeting");
		setLocale("zh-CN");
	});

	test("duplicate keys across domains fail loudly (module-load guard)", async () => {
		const mod = await import("../src/i18n/zh-CN/index.ts");
		expect(Object.keys(mod.zhCN).length).toBeGreaterThan(2000);
	});
});
