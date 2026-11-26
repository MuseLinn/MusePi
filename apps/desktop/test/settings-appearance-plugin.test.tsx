import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/settings-appearance/index";
import { apply } from "../src/plugins/settings-appearance/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("settings-appearance Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id appearance and takes over that page", () => {
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
				id: "appearance",
				moduleUrl: "./page.tsx",
				label: "外观",
				icon: "palette",
				order: 1,
				keywords: ["外观", "appearance", "主题", "theme", "强调色", "accent", "头像", "avatar", "品牌"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "appearance")).toBe(false);

		const items = navGroups([{ id: "appearance", label: "外观" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "appearance")).toBe(true);
		expect(items.some(item => item.id === "ext:appearance")).toBe(false);
	});
});
