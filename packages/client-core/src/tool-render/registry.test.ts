import { describe, expect, test } from "bun:test";
import { TOOL_RENDER_CARD_TOOLS } from "./card-tools.js";
import { builtinRendererToolNames, registerExternalToolRenderers, resolveToolRenderer } from "./registry.js";

describe("tool-render card inventory (TOOL_RENDER_CARD_TOOLS)", () => {
	test("inventory matches the builtin renderer registry exactly", () => {
		// Failure mode: a renderer is added to (or removed from) RENDERERS
		// without updating the canonical inventory — the extension center's
		// tool-render pack entry then advertises a stale tool list.
		expect([...TOOL_RENDER_CARD_TOOLS].sort()).toEqual([...builtinRendererToolNames()].sort());
	});
});

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
