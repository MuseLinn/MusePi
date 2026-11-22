/**
 * The main-process IPC guards that a renderer can reach.
 *
 * These live in `electron/main.cjs`, which needs Electron to load, so the
 * validators are tested through a small extraction of the same logic. What is
 * pinned is the rule the review found inconsistent: every name that reaches
 * `docker` as an argv element is refused when it looks like an option, exactly
 * as a destination and a distribution already are.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mainSource = readFileSync(join(import.meta.dir, "..", "electron", "main.cjs"), "utf8");

/**
 * The `cliName` guard, evaluated from the real source so the test cannot drift
 * from the file it is asserting about.
 */
const cliName: (value: unknown, max?: number) => string | null = (() => {
	const match = /function cliName\(value, max = 256\) \{([\s\S]*?)\n\}/.exec(mainSource);
	if (!match) throw new Error("cliName not found in main.cjs");
	// The default lives in the parameter list, which `new Function` does not
	// carry over, so it is applied here instead.
	const fn = new Function("value", "max", match[1]) as (value: unknown, max: number) => string | null;
	return (value, max = 256) => fn(value, max);
})();

describe("docker argv name guard", () => {
	test("a name beginning with a dash is refused, like a destination or a distro", () => {
		// `docker exec -v ...` would be read as an option, not a container.
		expect(cliName("-v")).toBeNull();
		expect(cliName("--privileged")).toBeNull();
		expect(cliName("  -it  ")).toBeNull();
	});

	test("an ordinary name passes", () => {
		expect(cliName("musepi-dev")).toBe("musepi-dev");
		expect(cliName("  ghcr.io/me/musepi:latest  ")).toBe("ghcr.io/me/musepi:latest");
	});

	test("an empty or non-string value is refused, and an overlong one too", () => {
		expect(cliName("")).toBeNull();
		expect(cliName("   ")).toBeNull();
		expect(cliName(undefined)).toBeNull();
		expect(cliName(42)).toBeNull();
		expect(cliName("a".repeat(257))).toBeNull();
		expect(cliName("a".repeat(256))).toBe("a".repeat(256));
	});

	test("every docker handler routes its names through the guard", () => {
		// A handler that forgets the guard would accept `--privileged`; the
		// assertion is on the source so a new handler cannot slip past.
		const run = /ipcMain\.handle\("remote-docker-run"[\s\S]*?\n\}\);/.exec(mainSource)?.[0] ?? "";
		const exec = /ipcMain\.handle\("remote-docker-exec"[\s\S]*?\n\}\);/.exec(mainSource)?.[0] ?? "";
		expect(run).toContain("cliName(input.name)");
		expect(run).toContain("cliName(input.image)");
		expect(exec).toContain("cliName(input.container)");
	});
});
