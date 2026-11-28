import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/ui-commands/index";
import { apply } from "../src/plugins/ui-commands/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("ui-commands Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id commands and takes over that page", () => {
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
				id: "commands",
				moduleUrl: "./page.tsx",
				label: "命令",
				icon: "command",
				order: 4,
				keywords: ["命令", "command", "slash", "斜杠", "自定义", "快捷"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "commands")).toBe(false);

		const items = navGroups([{ id: "commands", label: "命令" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "commands")).toBe(true);
		expect(items.some(item => item.id === "ext:commands")).toBe(false);
	});
});
