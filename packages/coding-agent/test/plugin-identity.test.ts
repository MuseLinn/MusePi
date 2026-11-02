import { describe, expect, test } from "bun:test";
import {
	isPluginDisabled,
	pluginEntryId,
	pluginNameOfEntryId,
	setPluginEnabledIn,
} from "../src/capability/plugin-identity";

describe("plugin identity", () => {
	test("uses only the package name", () => {
		expect(pluginEntryId("musepi-auth-hub")).toBe("musepi-auth-hub");
		expect(pluginNameOfEntryId("musepi-auth-hub")).toBe("musepi-auth-hub");
	});

	test("rejects composite IDs instead of interpreting them as packages", () => {
		expect(pluginNameOfEntryId("extension-module:musepi-auth-hub")).toBeUndefined();
		expect(pluginNameOfEntryId("plugin-module:musepi-auth-hub")).toBeUndefined();
		expect(pluginNameOfEntryId("voice:stt")).toBeUndefined();
		expect(pluginNameOfEntryId("skill:pdf")).toBeUndefined();
	});
});

describe("plugin enablement", () => {
	test("only a disabled package name disables that package", () => {
		expect(isPluginDisabled(["auth-hub"], "auth-hub")).toBe(true);
		expect(isPluginDisabled(["extension-module:auth-hub"], "auth-hub")).toBe(false);
		expect(isPluginDisabled(["other"], "auth-hub")).toBe(false);
	});

	test("writes only the package name and preserves unrelated capabilities", () => {
		const before = ["extension-module:auth-hub", "voice:stt", "unrelated"];
		expect(setPluginEnabledIn(before, "auth-hub", false)).toEqual([
			"extension-module:auth-hub",
			"voice:stt",
			"unrelated",
			"auth-hub",
		]);
		expect(setPluginEnabledIn(["auth-hub", "unrelated"], "auth-hub", true)).toEqual(["unrelated"]);
	});

	test("toggling twice returns to the original state", () => {
		const start = ["unrelated"];
		const off = setPluginEnabledIn(start, "auth-hub", false);
		expect(setPluginEnabledIn(off, "auth-hub", true)).toEqual(start);
	});
});
