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

	it("registers the settings.section.memory page as 记忆", () => {
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
				slot: "settings.section.memory",
				moduleUrl: "./page.tsx",
				label: "记忆",
				availability: "always",
			},
		]);
		// The memory page is no longer its own nav row: the merged 会话与记忆 page
		// owns the row, and this slot renders inside its memory group. The slot
		// still must not appear as a duplicate extension row.
		const items = navGroups([{ slot: "settings.section.memory", label: "记忆" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "ext:settings.section.memory")).toBe(false);
		expect(items.find(item => item.id === "memory")).toBeUndefined();
		expect(items.find(item => item.id === "session-memory")?.label).toBe(t("settings.sessionMemory"));
	});
});
