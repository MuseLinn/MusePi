import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as hooksPlugin from "../src/plugins/settings-hooks/index";
import { apply } from "../src/plugins/settings-hooks/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("settings-hooks Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(hooksPlugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id hooks and takes over that page", () => {
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
				id: "hooks",
				moduleUrl: "./page.tsx",
				label: "钩子",
				availability: "always",
			},
		]);
		// The page keeps its own nav row: only the content is plugin-owned.
		const items = navGroups([{ id: "hooks", label: t("settings.hooks") }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "ext:hooks")).toBe(false);
	});
});
