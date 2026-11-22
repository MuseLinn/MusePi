/**
 * `test-desktop` contract tests.
 *
 * The wrapper exists so one command cannot produce two verdicts. Its first
 * version did exactly that in the other direction: it changed into the package
 * (so the DOM preload loaded) but ran bare `bun test <args>`, dropping the
 * package script's `--isolate --timeout=15000`. On one tree, the same seven
 * files gave 7 failures through that wrapper and 0 with the package's own flags.
 *
 * These cases pin the composition so it cannot regress: the script's flags
 * always survive, and the caller narrows WHAT runs without changing HOW.
 */
import { describe, expect, test } from "bun:test";
import { commandFor } from "./test-desktop";

const SCRIPT = "bun test --isolate --timeout=15000 test";

describe("commandFor", () => {
	test("keeps the package's flags when the caller names no target", () => {
		expect(commandFor(SCRIPT, [])).toEqual(["test", "--isolate", "--timeout=15000", "test"]);
	});

	test("keeps the package's flags when the caller names a file", () => {
		// The shipped defect: this path used to be `["test", "user-avatar.test.ts"]`,
		// which shares one happy-dom registry across files and reports cross-file
		// failures the package run does not have.
		const command = commandFor(SCRIPT, ["user-avatar.test.ts"]);
		expect(command).toContain("--isolate");
		expect(command).toContain("--timeout=15000");
		expect(command.at(-1)).toBe("user-avatar.test.ts");
	});

	test("drops the script's own path when the caller names targets", () => {
		// Appending the file after the script's `test` directory made Bun run the
		// directory AND the file — the whole suite — instead of the subset asked
		// for. The caller's target replaces the default path; flags are separate.
		const command = commandFor(SCRIPT, ["user-avatar.test.ts"]);
		expect(command.filter(token => token === "test")).toHaveLength(1);
	});

	test("forwards the caller's own flags alongside the package's", () => {
		const command = commandFor(SCRIPT, ["test/foo.test.tsx", "-t", "one case"]);
		expect(command).toEqual(["test", "--isolate", "--timeout=15000", "test/foo.test.tsx", "-t", "one case"]);
	});

	test("refuses a script it cannot extend safely", () => {
		// A piped or compound script would change meaning when appended to; the
		// wrapper must say so rather than run something the package never runs.
		expect(() => commandFor("bun test --isolate test && echo done", [])).toThrow(/not a plain/);
		expect(() => commandFor("vitest run", [])).toThrow(/not a plain/);
	});

	test("reads the real package script and keeps both of its flags", () => {
		// Ties the contract to the manifest it exists to honour: if someone drops
		// `--isolate` from `apps/desktop`, this fails rather than the wrapper
		// silently losing the guarantee.
		const manifest = require("../apps/desktop/package.json") as { scripts: Record<string, string> };
		const command = commandFor(manifest.scripts.test as string, ["x.test.ts"]);
		expect(command).toContain("--isolate");
		expect(command).toContain("--timeout=15000");
	});
});
