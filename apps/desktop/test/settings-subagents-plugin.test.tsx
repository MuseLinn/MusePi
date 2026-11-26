import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/settings-subagents/index";
import { apply } from "../src/plugins/settings-subagents/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("settings-subagents Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id subagents and takes over that page", () => {
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
				id: "subagents",
				moduleUrl: "./page.tsx",
				label: "任务与子智能体",
				icon: "user",
				order: 16,
				keywords: ["子智能体", "subagent", "任务", "task", "模型", "model", "并行", "parallel"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "subagents")).toBe(false);

		const items = navGroups([{ id: "subagents", label: "任务与子智能体" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "subagents")).toBe(true);
		expect(items.some(item => item.id === "ext:subagents")).toBe(false);
	});
});
