import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as plugin from "../src/plugins/ui-settings-files/index";
import { apply } from "../src/plugins/ui-settings-files/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("ui-settings-files Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(plugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id files and takes over that page", () => {
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
				id: "files",
				moduleUrl: "./page.tsx",
				label: "文件与 LSP",
				icon: "file-text",
				order: 8,
				keywords: ["文件", "file", "lsp", "语言服务", "编辑", "edit", "读取", "read", "摘要", "summarize"],
				availability: "always",
			},
		]);
		// The page is plugin-owned: no contribution means no nav row, never a blank page.
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "files")).toBe(false);

		const items = navGroups([{ id: "files", label: "文件与 LSP" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "files")).toBe(true);
		expect(items.some(item => item.id === "ext:files")).toBe(false);
	});
});
