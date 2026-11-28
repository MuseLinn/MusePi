import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/ui-settings-context/index";
import { apply } from "../src/plugins/ui-settings-context/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("ui-settings-context Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id context and takes over that page", () => {
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
				id: "context",
				moduleUrl: "./page.tsx",
				label: "上下文",
				icon: "stack",
				order: 10,
				keywords: [
					"上下文",
					"context",
					"压缩",
					"compact",
					"窗口",
					"window",
					"token",
					"令牌",
					"限制",
					"limit",
					"目录",
					"directory",
				],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "context")).toBe(false);

		const items = navGroups([{ id: "context", label: "上下文" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "context")).toBe(true);
		expect(items.some(item => item.id === "ext:context")).toBe(false);
	});
});
