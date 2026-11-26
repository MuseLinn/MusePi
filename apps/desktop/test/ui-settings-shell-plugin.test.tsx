import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/ui-settings-shell/index";
import { apply } from "../src/plugins/ui-settings-shell/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("ui-settings-shell Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id shell and takes over that page", () => {
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
				id: "shell",
				moduleUrl: "./page.tsx",
				label: "Shell",
				icon: "terminal-window",
				order: 11,
				keywords: ["shell", "bash", "终端", "terminal", "求值", "eval", "minimizer", "压缩", "savings"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "shell")).toBe(false);

		const items = navGroups([{ id: "shell", label: "Shell" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "shell")).toBe(true);
		expect(items.some(item => item.id === "ext:shell")).toBe(false);
	});
});
