import { describe, expect, it } from "bun:test";
import { EXTENSION_HOST_MODULES, matchExtensionHostModule } from "../src/extension-host-modules";

describe("extension host module table", () => {
	it("keeps keys unique", () => {
		const keys = EXTENSION_HOST_MODULES.map(entry => entry.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("declares exactly one match rule per entry", () => {
		for (const entry of EXTENSION_HOST_MODULES) {
			const rules = [
				"path" in entry ? entry.path : undefined,
				"specifier" in entry ? entry.specifier : undefined,
			].filter(value => value !== undefined);
			expect(rules).toHaveLength(1);
		}
	});

	it("matches relative imports at any depth, with or without extension", () => {
		expect(matchExtensionHostModule("../lib/prompt-dialog")).toBe("prompt-dialog");
		expect(matchExtensionHostModule("../../lib/action-toast.ts")).toBe("action-toast");
		expect(matchExtensionHostModule("../lib/use-floating-menu.tsx")).toBe("floating-menu");
		expect(matchExtensionHostModule("..\\lib\\file-workspace")).toBe("file-workspace");
	});

	it("matches sibling imports inside lib to the same module identity", () => {
		expect(matchExtensionHostModule("./managed-browser-host", "D:/app/src/lib/managed-browser-bridge.ts")).toBe(
			"managed-browser-host",
		);
		expect(matchExtensionHostModule("./managed-browser-host", "D:/app/src/components/other.tsx")).toBeUndefined();
	});

	it("does not match a longer sibling module name", () => {
		expect(matchExtensionHostModule("../lib/action-toast-extra")).toBeUndefined();
		expect(matchExtensionHostModule("../lib/prompt-dialogues")).toBeUndefined();
	});

	it("matches bare specifiers exactly", () => {
		expect(matchExtensionHostModule("@musepi/client-core")).toBe("client-core");
		expect(matchExtensionHostModule("@musepi/client-core/index.js")).toBe("client-core");
		expect(matchExtensionHostModule("@musepi/client-core/src/i18n")).toBe("i18n");
		expect(matchExtensionHostModule("@musepi/client-core/src/i18n/index")).toBe("i18n");
		expect(matchExtensionHostModule("@musepi/client-core/src/i18n/index.js")).toBe("i18n");
	});

	it("matches client-core's own relative i18n imports", () => {
		const importer = "D:/app/packages/client-core/src/components/demo.tsx";
		expect(matchExtensionHostModule("../i18n/index.js", importer)).toBe("i18n");
		expect(matchExtensionHostModule("../i18n", importer)).toBe("i18n");
		expect(matchExtensionHostModule("../i18n/index.ts", importer)).toBe("i18n");
	});

	it("keeps relative i18n imports outside client-core in the bundle", () => {
		expect(
			matchExtensionHostModule("../i18n/index.js", "D:/app/packages/other/src/components/demo.tsx"),
		).toBeUndefined();
		expect(matchExtensionHostModule("../i18n/index.js", "D:/app/src/components/demo.tsx")).toBeUndefined();
		expect(
			matchExtensionHostModule("../i18n-extra", "D:/app/packages/client-core/src/components/demo.tsx"),
		).toBeUndefined();
		expect(
			matchExtensionHostModule("../theme", "D:/app/packages/client-core/src/components/demo.tsx"),
		).toBeUndefined();
	});

	it("does not match a bare specifier by suffix or prefix", () => {
		expect(matchExtensionHostModule("@musepi/client-core/src/i18n/extra")).toBeUndefined();
		expect(matchExtensionHostModule("@musepi/client-core-extra")).toBeUndefined();
		expect(matchExtensionHostModule("@musepi/client-core/src/other")).toBeUndefined();
	});

	it("leaves pure helpers in the plugin bundle", () => {
		expect(matchExtensionHostModule("../lib/leaf-walk")).toBeUndefined();
		expect(matchExtensionHostModule("react")).toBeUndefined();
	});
});
