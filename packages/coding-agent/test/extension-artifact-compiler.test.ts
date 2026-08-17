import { describe, expect, test } from "bun:test";
import { collectSlotComponents } from "../src/daemon/extension-artifact-compiler.js";

const EXAMPLE_EXT = new URL("../examples/extension-component/index.ts", import.meta.url).pathname.replace(
	/^\/([A-Za-z]:)/,
	"$1",
);

describe("extension slot components", () => {
	test("compiles an active extension-module component to host-bound ESM", async () => {
		const components = await collectSlotComponents(
			[{ kind: "extension-module", state: "active", path: EXAMPLE_EXT }],
			process.cwd(),
		);
		expect(components).toHaveLength(1);
		const c = components[0]!;
		expect(c.slot).toBe("settings.extensions");
		expect(c.label).toBe("Greeting card");
		// Compiled output binds to the HOST react instance — never a bundled
		// copy (double react would null the hooks dispatcher).
		expect(c.code).toContain("window.MusePiReact");
		expect(c.code).not.toContain('from"react"');
		expect(c.error).toBeUndefined();
	}, 60_000);

	test("skips non-extension-module entries and shadowed states", async () => {
		const components = await collectSlotComponents(
			[
				{ kind: "skill", state: "active", path: "C:/tmp/skill.md" },
				{ kind: "extension-module", state: "disabled", path: EXAMPLE_EXT },
			],
			process.cwd(),
		);
		expect(components).toHaveLength(0);
	});
});
