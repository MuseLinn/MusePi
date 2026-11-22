import { describe, expect, test } from "bun:test";
import { BUILTIN_MODE_TEMPLATES, resolveMode } from "@musepi/pi-coding-agent/presets/resolve";
import { STANDARD_TOP_LEVEL_TOOL_NAMES } from "@musepi/pi-coding-agent/presets/standard-profile";

/**
 * Contract: the default `work` profile declares no preset prompt and no preset
 * rows — its capability packages come from ambient discovery — while its
 * top-level tool surface is the declared standard list. A profile that wants a
 * different surface states `topLevelTools` itself.
 */
describe("work profile surface", () => {
	const resolve = (id: string) => resolveMode(id, modeId => BUILTIN_MODE_TEMPLATES[modeId]);

	test("work declares no prompt override and no preset rows", () => {
		const work = BUILTIN_MODE_TEMPLATES.work!;
		expect(work.prompt ?? []).toEqual([]);
		expect(work.plugins ?? []).toEqual([]);
	});

	test("work leaves topLevelTools unset so the standard surface applies by id", () => {
		expect(BUILTIN_MODE_TEMPLATES.work!.topLevelTools).toBeUndefined();
		expect(resolve("work").topLevelTools).toBeUndefined();
	});

	test("a profile can declare its own surface, and it resolves verbatim", () => {
		const resolved = resolveMode("custom", id =>
			id === "custom"
				? { id: "custom", label: "Custom", topLevelTools: ["read", "bash"], plugins: [] }
				: BUILTIN_MODE_TEMPLATES[id]!,
		);
		expect(resolved.topLevelTools).toEqual(["read", "bash"]);
		// The standard list is the default only; it is not merged into a declaration.
		expect(resolved.topLevelTools).not.toEqual([...STANDARD_TOP_LEVEL_TOOL_NAMES]);
	});

	test("the declared standard surface covers the file and search essentials", () => {
		for (const name of ["read", "write", "bash", "edit", "glob", "grep"]) {
			expect(STANDARD_TOP_LEVEL_TOOL_NAMES).toContain(name);
		}
	});
});
