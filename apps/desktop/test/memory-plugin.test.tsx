import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as memoryPlugin from "../src/plugins/memory/index";
import { apply } from "../src/plugins/memory/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("memory Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(memoryPlugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.tab.memory page as 记忆", () => {
		const registrations: unknown[] = [];
		apply({
			setLabel() {},
			slots: {
				register(component) {
					registrations.push(component);
				},
			},
		});
		expect(registrations).toEqual([
			{
				slot: "settings.tab.memory",
				moduleUrl: "./page.tsx",
				label: "记忆",
				availability: "always",
			},
		]);
		const items = navGroups([{ slot: "settings.tab.memory", label: "记忆" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "ext:settings.tab.memory")).toBe(false);
		expect(items.find(item => item.id === "memory")?.label).toBe(t("settings.memorySettings"));
	});
});
