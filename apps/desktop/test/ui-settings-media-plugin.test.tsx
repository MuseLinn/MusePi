import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/ui-settings-media/index";
import { apply } from "../src/plugins/ui-settings-media/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("ui-settings-media Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id skills and takes over that page", () => {
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
				id: "media",
				moduleUrl: "./page.tsx",
				label: "图像与视频生成",
				icon: "image-download",
				order: 20,
				keywords: ["图像", "image", "视频", "video", "生成", "generate", "供应商", "provider"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "media")).toBe(false);

		const items = navGroups([{ id: "media", label: "图像与视频生成" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "media")).toBe(true);
		expect(items.some(item => item.id === "ext:skills")).toBe(false);
	});
});
