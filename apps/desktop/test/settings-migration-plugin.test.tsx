import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/settings-migration/index";
import { apply } from "../src/plugins/settings-migration/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("settings-migration Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id migration and takes over that page", () => {
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
				id: "migration",
				moduleUrl: "./page.tsx",
				label: "数据迁移",
				icon: "download",
				order: 15,
				keywords: ["迁移", "migration", "导入", "import", "数据", "data", "安装", "install"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "migration")).toBe(false);

		const items = navGroups([{ id: "migration", label: "数据迁移" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "migration")).toBe(true);
		expect(items.some(item => item.id === "ext:migration")).toBe(false);
	});
});
