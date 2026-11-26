import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/ui-settings-models/index";
import { apply } from "../src/plugins/ui-settings-models/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("settings-model Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id model and takes over that page", () => {
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
				id: "model",
				moduleUrl: "./page.tsx",
				label: "模型与供应商",
				icon: "ai-agent",
				order: 9,
				keywords: ["模型", "model", "供应商", "provider", "登录", "login", "密钥", "key", "自定义", "custom"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "model")).toBe(false);

		const items = navGroups([{ id: "model", label: "模型与供应商" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "model")).toBe(true);
		expect(items.some(item => item.id === "ext:model")).toBe(false);
	});
});
