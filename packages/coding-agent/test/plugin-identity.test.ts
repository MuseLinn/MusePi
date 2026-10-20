/**
 * 插件身份与启停 —— 与 dsh 的 `PluginEntryId` + `entry.disabled` 同模型。
 *
 * 守的是「改分类不能弄丢用户的启停状态」这条用户可见契约：身份是插件名，
 * 分类（kind）只是标签，两者结构上就该无关。
 */

import { describe, expect, test } from "bun:test";
import {
	isPluginDisabled,
	legacyModuleEntryIds,
	pluginEntryId,
	pluginNameOfEntryId,
	setPluginEnabledIn,
} from "../src/capability/plugin-identity";

describe("plugin identity", () => {
	test("the identity is the plugin name, with no kind in it", () => {
		// The reference's PluginEntryId is a loader-tree entry identity; a kind
		// prefix in ours is what let a classification change orphan a toggle.
		expect(pluginEntryId("musepi-auth-hub")).toBe("musepi-auth-hub");
		expect(pluginEntryId("musepi-auth-hub")).not.toContain(":");
	});

	test("reads the identity out of every historical form", () => {
		// Old records must keep resolving to the same plugin, or a user's existing
		// toggles silently stop applying.
		expect(pluginNameOfEntryId("musepi-auth-hub")).toBe("musepi-auth-hub");
		expect(pluginNameOfEntryId("extension-module:musepi-auth-hub")).toBe("musepi-auth-hub");
		expect(pluginNameOfEntryId("plugin-module:musepi-auth-hub")).toBe("musepi-auth-hub");
	});

	test("does not mistake another capability's id for a plugin", () => {
		// `skill:foo` names a skill, not a plugin. Treating it as one would let a
		// plugin toggle read a skill's disabled flag.
		expect(pluginNameOfEntryId("skill:pdf")).toBeUndefined();
		expect(pluginNameOfEntryId("hook:guard")).toBeUndefined();
	});

	test("lists the legacy forms it will accept on read", () => {
		expect(legacyModuleEntryIds("x")).toEqual(["x", "extension-module:x", "plugin-module:x"]);
	});
});

describe("plugin enablement", () => {
	test("a toggle stored under a legacy id still disables the plugin", () => {
		// This is the migration guarantee: data written before the identity change
		// keeps working, with no migration pass required.
		expect(isPluginDisabled(["extension-module:auth-hub"], "auth-hub")).toBe(true);
		expect(isPluginDisabled(["plugin-module:auth-hub"], "auth-hub")).toBe(true);
		expect(isPluginDisabled(["auth-hub"], "auth-hub")).toBe(true);
	});

	test("an unrelated plugin's toggle does not leak", () => {
		expect(isPluginDisabled(["extension-module:other"], "auth-hub")).toBe(false);
		expect(isPluginDisabled([], "auth-hub")).toBe(false);
	});

	test("disabling writes the bare name and clears every legacy record", () => {
		// Two records for one plugin can disagree; the next read would have to
		// guess which wins. A write therefore collapses them into one.
		const before = ["extension-module:auth-hub", "plugin-module:auth-hub", "unrelated"];
		expect(setPluginEnabledIn(before, "auth-hub", false)).toEqual(["unrelated", "auth-hub"]);
	});

	test("enabling removes the record instead of storing enabled", () => {
		// The setting is a DISABLED list, so enabling is the absence of a record.
		// Storing a record for an enabled plugin would also mark it disabled.
		const before = ["extension-module:auth-hub", "unrelated"];
		expect(setPluginEnabledIn(before, "auth-hub", true)).toEqual(["unrelated"]);
	});

	test("toggling twice returns to the original state", () => {
		const start = ["unrelated"];
		const off = setPluginEnabledIn(start, "auth-hub", false);
		const on = setPluginEnabledIn(off, "auth-hub", true);
		expect(on).toEqual(start);
	});
});
