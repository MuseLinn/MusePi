import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/ui-extensions-plugins/index";
import { apply } from "../src/plugins/ui-extensions-plugins/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("ui-extensions-plugins Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id skills and takes over that page", () => {
		const registrations: unknown[] = [];
		apply({
			slots: {
				register(component) {
					registrations.push(component);
				},
			},
		});
		expect(registrations).toEqual([
			{
				slot: "settings.section",
				id: "skills",
				moduleUrl: "./page.tsx",
				label: "扩展与插件",
				icon: "sparkling",
				order: 19,
				keywords: ["扩展", "插件", "extension", "plugin", "技能", "skill", "上下文", "context"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "skills")).toBe(false);

		const items = navGroups([{ id: "skills", label: "扩展与插件" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "skills")).toBe(true);
		expect(items.some(item => item.id === "ext:skills")).toBe(false);
	});
});
