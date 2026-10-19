/**
 * `--profile` names a plugin composition; `--home` names a state home.
 *
 * Before this rename one flag did both: `--profile work` pointed the agent dir at
 * `~/.musepi/profiles/work/agent` AND named the composition read from
 * `~/.musepi/profiles/work/`. Two axes under one word, so "try a different set of
 * plugins" silently moved the user's sessions.
 *
 * These cases pin the split and the compatibility path that keeps existing state
 * reachable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractProfileFlags } from "../src/cli/profile-bootstrap";

describe("flag parsing", () => {
	test("--profile and --home are captured separately", () => {
		// The whole point of the rename: one flag no longer means both things.
		const result = extractProfileFlags(["--profile", "desk", "--home", "work", "run"]);
		expect(result.profile).toBe("desk");
		expect(result.stateHome).toBe("work");
		expect(result.argv).toEqual(["run"]);
	});

	test("--profile alone captures no state home", () => {
		// Selecting a composition must not redirect where state lives.
		const result = extractProfileFlags(["--profile", "desk"]);
		expect(result.profile).toBe("desk");
		expect(result.stateHome).toBeUndefined();
	});

	test("--home alone captures no profile", () => {
		const result = extractProfileFlags(["--home", "work"]);
		expect(result.profile).toBeUndefined();
		expect(result.stateHome).toBe("work");
	});

	test("the --flag=value spelling works for both", () => {
		// Scripts use this form; missing it would silently drop the selection.
		const result = extractProfileFlags(["--profile=desk", "--home=work"]);
		expect(result.profile).toBe("desk");
		expect(result.stateHome).toBe("work");
	});

	test("a missing value is refused for both flags", () => {
		// A bare trailing flag would otherwise be read as "default", which looks
		// like a successful no-op instead of the typo it is.
		expect(() => extractProfileFlags(["--profile"])).toThrow();
		expect(() => extractProfileFlags(["--home"])).toThrow();
	});

	test("a flag-looking value is refused, not consumed", () => {
		// `--home --profile desk` must not set the home to "--profile".
		expect(() => extractProfileFlags(["--home", "--profile", "desk"])).toThrow();
	});
});

describe("legacy state detection", () => {
	let home = "";
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-home-"));
	});
	afterEach(async () => {
		await fs.rm(home, { recursive: true, force: true });
	});

	test("a state directory under the old layout is what marks legacy data", async () => {
		// Before the rename `--profile <name>` created `<config>/profiles/<name>/agent`.
		// The directory's existence is the marker — there was no version stamp to
		// read back then, and inventing one now would miss every existing user.
		const legacyAgentDir = path.join(home, "profiles", "work", "agent");
		await fs.mkdir(legacyAgentDir, { recursive: true });
		expect(await isDirectory(legacyAgentDir)).toBe(true);

		const otherAgentDir = path.join(home, "profiles", "fresh", "agent");
		expect(await isDirectory(otherAgentDir)).toBe(false);
	});
});

/** Whether a path is an existing directory (`Bun.file().exists()` is for files). */
async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await fs.stat(target)).isDirectory();
	} catch {
		return false;
	}
}
