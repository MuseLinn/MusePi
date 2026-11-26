import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/shortcuts-settings/index";
import { apply } from "../src/plugins/shortcuts-settings/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("shortcuts-settings Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id shortcuts and takes over that page", () => {
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
				id: "shortcuts",
				moduleUrl: "./page.tsx",
				label: "快捷键",
				icon: "command",
				order: 5,
				keywords: ["快捷键", "shortcut", "键位", "keybind", "绑定", "binding"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "shortcuts")).toBe(false);

		const items = navGroups([{ id: "shortcuts", label: "快捷键" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "shortcuts")).toBe(true);
		expect(items.some(item => item.id === "ext:shortcuts")).toBe(false);
	});
});
