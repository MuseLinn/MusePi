import { describe, expect, it } from "bun:test";
import { EXTENSION_HOST_MODULES, matchExtensionHostModule } from "../src/extension-host-modules";

describe("extension host module table", () => {
	it("keeps keys unique", () => {
		const keys = EXTENSION_HOST_MODULES.map(entry => entry.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("declares exactly one match rule per entry", () => {
		for (const entry of EXTENSION_HOST_MODULES) {
			const rules = [entry.path, entry.specifier].filter(value => value !== undefined);
			expect(rules).toHaveLength(1);
		}
	});

	it("matches relative imports at any depth, with or without extension", () => {
		expect(matchExtensionHostModule("../lib/prompt-dialog")).toBe("prompt-dialog");
		expect(matchExtensionHostModule("../../lib/action-toast.ts")).toBe("action-toast");
		expect(matchExtensionHostModule("../lib/use-floating-menu.tsx")).toBe("floating-menu");
		expect(matchExtensionHostModule("..\\lib\\file-workspace")).toBe("file-workspace");
	});

	it("does not match a longer sibling module name", () => {
		expect(matchExtensionHostModule("../lib/action-toast-extra")).toBeUndefined();
		expect(matchExtensionHostModule("../lib/prompt-dialogues")).toBeUndefined();
	});

	it("leaves pure helpers in the plugin bundle", () => {
		expect(matchExtensionHostModule("../lib/leaf-walk")).toBeUndefined();
		expect(matchExtensionHostModule("react")).toBeUndefined();
	});
});
