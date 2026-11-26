import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/usage-settings/index";
import { apply } from "../src/plugins/usage-settings/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("usage-settings Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id usage and takes over that page", () => {
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
				id: "usage",
				moduleUrl: "./page.tsx",
				label: "使用统计",
				icon: "star",
				order: 7,
				keywords: ["统计", "usage", "用量", "成本", "cost", "token", "模型", "model", "月度", "monthly"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "usage")).toBe(false);

		const items = navGroups([{ id: "usage", label: "使用统计" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "usage")).toBe(true);
		expect(items.some(item => item.id === "ext:usage")).toBe(false);
	});
});
