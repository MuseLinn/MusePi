/**
 * 命名空间 i18n —— 两个插件的同名 key 不能互相覆盖。
 *
 * 扁平 seam 的问题是可观测的：插件 A 注册 `title`，插件 B 也注册 `title`，
 * 后注册的赢，而赢家取决于装载顺序。用户看到的是「某个插件的按钮变成了另一个
 * 插件的文案」，且没有任何报错。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	bindTranslationNamespace,
	getLocaleSnapshot,
	registerTranslationNamespace,
	registerTranslations,
	setLocale,
	tLoose,
	unregisterTranslationNamespace,
} from "../src/i18n/index";

const NAMESPACES = ["probe-a", "probe-b"];
const INITIAL_LOCALE = getLocaleSnapshot();

afterEach(() => {
	for (const namespace of NAMESPACES) unregisterTranslationNamespace(namespace);
	setLocale(INITIAL_LOCALE);
});

describe("namespaced translation", () => {
	test("two plugins can use the same key without colliding", async () => {
		// The whole point of the namespace: `title` is A's and B's own.
		registerTranslationNamespace("probe-a", { "zh-CN": { title: "A 的标题" } });
		registerTranslationNamespace("probe-b", { "zh-CN": { title: "B 的标题" } });
		setLocale("zh-CN");
		expect(tLoose("probe-a:title")).toBe("A 的标题");
		expect(tLoose("probe-b:title")).toBe("B 的标题");
	});

	test("a bound translator takes bare keys", async () => {
		// `ctx.locale.bind(NS)` in the reference: the component writes `t("title")`
		// and never repeats its namespace.
		registerTranslationNamespace("probe-a", { "zh-CN": { title: "A 的标题" } });
		setLocale("zh-CN");
		const t = bindTranslationNamespace("probe-a");
		expect(t("title")).toBe("A 的标题");
		expect(t.namespace).toBe("probe-a");
	});

	test("a bound translator cannot reach another namespace", async () => {
		// A missing key falls back to the key itself (the established behaviour),
		// and crucially does NOT resolve to B's string.
		registerTranslationNamespace("probe-b", { "zh-CN": { title: "B 的标题" } });
		const t = bindTranslationNamespace("probe-a");
		expect(t("title")).not.toBe("B 的标题");
	});

	test("registering twice under one namespace is idempotent, not double-prefixed", async () => {
		// A reload re-runs the plugin's module: `probe-a:probe-a:title` would make
		// every label fall back to a raw key.
		registerTranslationNamespace("probe-a", { "zh-CN": { title: "第一次" } });
		registerTranslationNamespace("probe-a", { "zh-CN": { "probe-a:title": "第二次" } });
		setLocale("zh-CN");
		expect(tLoose("probe-a:title")).toBe("第二次");
		expect(tLoose("probe-a:probe-a:title")).toBe("probe-a:probe-a:title");
	});

	test("unregistering drops exactly that namespace", async () => {
		registerTranslationNamespace("probe-a", { "zh-CN": { title: "A" } });
		registerTranslationNamespace("probe-b", { "zh-CN": { title: "B" } });
		setLocale("zh-CN");
		unregisterTranslationNamespace("probe-a");
		expect(tLoose("probe-a:title")).toBe("probe-a:title");
		expect(tLoose("probe-b:title")).toBe("B");
	});

	test("a locale with no contribution still resolves the other locale", async () => {
		registerTranslationNamespace("probe-a", { "en-US": { title: "A title" } });
		setLocale("en-US");
		expect(tLoose("probe-a:title")).toBe("A title");
	});

	test("the flat seam keeps working alongside namespaces", async () => {
		// Existing plugins call `registerTranslations`; adding namespaces must not
		// change what they get.
		registerTranslations("zh-CN", { "probe-a:legacy": "旧的" });
		setLocale("zh-CN");
		expect(tLoose("probe-a:legacy")).toBe("旧的");
	});

	test("the bound translator's locale follows a switch", async () => {
		// Read lazily (a getter): a component that formats its own dates must not
		// capture the locale at bind time.
		const t = bindTranslationNamespace("probe-a");
		setLocale("zh-CN");
		const first = t.locale;
		setLocale("en-US");
		expect(t.locale).not.toBe(first);
	});

	test("an empty namespace is refused", () => {
		expect(() => registerTranslationNamespace("  ", { "zh-CN": {} })).toThrow(/must not be empty/);
	});

	test("switches away from the entry locale for the restoration check", () => {
		setLocale(INITIAL_LOCALE === "en-US" ? "zh-CN" : "en-US");
	});

	test("restores the locale that was active before this file ran", () => {
		expect(getLocaleSnapshot()).toBe(INITIAL_LOCALE);
	});
});
