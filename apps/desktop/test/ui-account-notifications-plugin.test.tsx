import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/ui-account-notifications/index";
import { apply } from "../src/plugins/ui-account-notifications/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("ui-account-notifications Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id notifications and takes over that page", () => {
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
				id: "notifications",
				moduleUrl: "./page.tsx",
				label: "通知与音效",
				icon: "notification-3",
				order: 6,
				keywords: ["通知", "notification", "音效", "sound", "声音", "免打扰", "quiet"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "notifications")).toBe(false);

		const items = navGroups([{ id: "notifications", label: "通知与音效" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "notifications")).toBe(true);
		expect(items.some(item => item.id === "ext:notifications")).toBe(false);
	});
});
