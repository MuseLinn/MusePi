import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import {
	declaredInject,
	declaredProvide,
	resolvePluginEntry,
} from "../../../packages/coding-agent/src/extensibility/plugins/runtime/cordis-entry";
import { navGroups } from "../src/components/SettingsNav";
import * as secretsPlugin from "../src/plugins/settings-secrets/index";
import { apply } from "../src/plugins/settings-secrets/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("settings-secrets Cordis plugin", () => {
	it("loads as a Cordis triple rather than a bare legacy factory", () => {
		const entry = resolvePluginEntry(secretsPlugin as never);
		expect(declaredInject(entry)).toEqual([]);
		expect(declaredProvide(entry)).toEqual([]);
	});

	it("registers the settings.section entry with id secrets and takes over that page", () => {
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
				id: "secrets",
				moduleUrl: "./page.tsx",
				label: "保险库",
				icon: "key",
				order: 3,
				keywords: ["保险库", "secret", "secrets", "vault", "凭据", "密钥", "env"],
				availability: "always",
			},
		]);
		// The page keeps its own nav row: only the content is plugin-owned.
		const items = navGroups([{ id: "secrets", label: t("settings.secrets") }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "ext:secrets")).toBe(false);
	});
});
