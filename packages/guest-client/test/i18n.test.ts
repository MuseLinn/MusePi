import { afterAll, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "../src/i18n/index.js";
import { zhCN } from "../src/i18n/zh-CN/index.js";

const INITIAL_LOCALE = getLocaleSnapshot();
afterAll(() => setLocale(INITIAL_LOCALE));

describe("i18n t()", () => {
	test("named-param replacement works on the localized string", () => {
		setLocale("zh-CN");
		expect(t("staged count", { count: 3 })).toBe("已暂存 3 个文件");
		expect(t("retry {attempt}/{max}: {reason}", { attempt: 2, max: 3, reason: "boom" })).toBe("重试 2/3：boom");
	});

	test("all {name} placeholders are replaceable from call-site params", () => {
		// Every zh-CN value's placeholders must be reachable by named params:
		// no stray {0}/{1} positional leftovers anywhere in the dict.
		for (const [key, value] of Object.entries(zhCN)) {
			expect(value, `positional placeholder left in zh-CN key "${key}"`).not.toMatch(/\{\d+\}/);
		}
	});

	test("english pass-through replaces named params on the key itself", () => {
		// en-US has no dict entry — the key (with {name}) is the fallback and
		// must still be interpolated, not rendered raw.
		setLocale("en-US");
		expect(t("staged count", { count: 2 })).toBe("staged count");
		expect(t("watching run #{id} on {repo}", { id: 7, repo: "a/b" })).toBe("watching run #7 on a/b");
		setLocale("zh-CN");
	});

	test("missing key falls back to the raw key; params untouched when absent", () => {
		expect(t("staged count")).toBe("已暂存 {count} 个文件");
	});

	test("missing translation key falls back to the key itself", () => {
		// @ts-expect-error — unknown keys are compile errors; runtime fallback still safe
		expect(t("this key does not exist")).toBe("this key does not exist");
	});

	test("locale snapshot round-trips", () => {
		const before = getLocaleSnapshot();
		setLocale("zh-CN");
		expect(getLocaleSnapshot()).toBe("zh-CN");
		setLocale(before);
	});
});
