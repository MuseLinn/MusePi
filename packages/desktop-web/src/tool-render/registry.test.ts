import { describe, expect, test } from "bun:test";
import { registerExternalToolRenderers, resolveToolRenderer } from "./registry.js";

describe("external tool renderers (registerToolView dispatch)", () => {
	test("external renderer overrides builtin for a known tool", () => {
		const external = { Summary: () => null } as never;
		registerExternalToolRenderers({ bash: external });
		expect(resolveToolRenderer("bash")).toBe(external);
		registerExternalToolRenderers({});
	});

	test("clear restores builtin dispatch", () => {
		registerExternalToolRenderers({ bash: { Summary: () => null } as never });
		registerExternalToolRenderers({});
		const after = resolveToolRenderer("bash");
		expect(after).not.toBeUndefined();
		expect(after.Summary).toBeDefined();
	});

	test("unknown tool falls back to generic", () => {
		registerExternalToolRenderers({});
		// A name with no builtin renderer resolves (generic fallback).
		const renderer = resolveToolRenderer("totally_unknown_tool");
		expect(renderer).toBeDefined();
		expect(typeof renderer.Summary).toBe("function");
	});
});
