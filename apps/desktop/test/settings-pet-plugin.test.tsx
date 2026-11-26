import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/settings-pet/index";
import { apply } from "../src/plugins/settings-pet/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("settings-pet Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id pet and takes over that page", () => {
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
				id: "pet",
				moduleUrl: "./page.tsx",
				label: "伙伴",
				icon: "robot-2",
				order: 14,
				keywords: ["伙伴", "pet", "形象", "art", "装饰", "decor", "市场", "market", "companion"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "pet")).toBe(false);

		const items = navGroups([{ id: "pet", label: "伙伴" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "pet")).toBe(true);
		expect(items.some(item => item.id === "ext:pet")).toBe(false);
	});
});
