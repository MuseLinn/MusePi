/**
 * A preset IS a list of plugin rows.
 *
 * The host layered conveniences on top of that (prompt sections, settings
 * overrides, a model role), but the thing a preset fundamentally declares is
 * which plugins are composed. These cases pin the composition semantics:
 * inheritance folding, the enable switch, and the validation that keeps a
 * half-mounted preset from being reported as fine.
 */

import { describe, expect, test } from "bun:test";
import type { ModeDefinition } from "../src/presets/resolve";
import { resolveMode, validateMode } from "../src/presets/resolve";

/** Validate one definition with no inheritance involved. */
function problemsOf(def: ModeDefinition): string[] {
	return validateMode(def);
}

/** Build a `.resolve()` over an in-memory definition map. */
function resolveIn(defs: Record<string, ModeDefinition>) {
	return resolveMode("child", id => defs[id]);
}

describe("composition folding across the inheritance chain", () => {
	test("a child inherits its parent's rows", () => {
		// Composition is the part a child most often wants unchanged: it extends a
		// preset to add one plugin, not to restate everything.
		const resolved = resolveIn({
			base: { id: "base", plugins: [{ name: "a" }, { name: "b" }] },
			child: { id: "child", extends: ["base"], plugins: [{ name: "c" }] },
		});
		expect(resolved.plugins.map(row => row.name)).toEqual(["a", "b", "c"]);
	});

	test("a child disables an inherited row instead of deleting it", () => {
		// Deleting would lose the fact that the parent composes it, and the UI
		// must be able to show "inherited but off" rather than silently nothing.
		const resolved = resolveIn({
			base: { id: "base", plugins: [{ name: "a", enabled: true }] },
			child: { id: "child", extends: ["base"], plugins: [{ name: "a", enabled: false }] },
		});
		expect(resolved.plugins).toHaveLength(1);
		expect(resolved.plugins[0]?.enabled).toBe(false);
	});

	test("a child reconfigures an inherited row in place", () => {
		// Same id, same slot: re-declaring is how an override is expressed, and it
		// must not append a second copy.
		const resolved = resolveIn({
			base: { id: "base", plugins: [{ name: "a", id: "shared" }] },
			child: { id: "child", extends: ["base"], plugins: [{ name: "a", id: "shared", enabled: false }] },
		});
		expect(resolved.plugins).toHaveLength(1);
		expect(resolved.plugins[0]?.enabled).toBe(false);
	});

	test("a preset with no rows resolves to an empty composition", () => {
		// Not `undefined`: "declares no plugins" and "the field is missing" are the
		// same state, and callers should not need both checks.
		expect(resolveIn({ child: { id: "child" } }).plugins).toEqual([]);
	});
});

describe("plugin rows", () => {
	test("a plain row is valid", () => {
		expect(problemsOf({ id: "p", plugins: [{ name: "musepi-auth-hub" }] })).toEqual([]);
	});

	test("a row with no name is refused", () => {
		// The composition cannot resolve what it cannot name, and a row that
		// mounts nothing is indistinguishable from one that silently failed.
		expect(problemsOf({ id: "p", plugins: [{ name: "  " }] })).toHaveLength(1);
	});

	test("duplicate row ids are refused", () => {
		// Two rows with one id: the fold keeps the last and the author never
		// learns the first was ignored.
		const problems = problemsOf({
			id: "p",
			plugins: [
				{ name: "a", id: "shared" },
				{ name: "b", id: "shared" },
			],
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("shared");
	});

	test("rows are keyed by name when no id is given", () => {
		// The id is the fold key, so two unnamed rows for the same plugin are the
		// same row — one replaces the other rather than mounting twice.
		const problems = problemsOf({ id: "p", plugins: [{ name: "a" }, { name: "a" }] });
		expect(problems).toHaveLength(1);
	});

	test("a nested row list requires group: true", () => {
		// `config` is read as a plugin's own config without the marker, so the
		// nested rows would be silently dropped instead of mounted.
		const problems = problemsOf({
			id: "p",
			plugins: [{ name: "a", config: [{ name: "b" }] }],
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("group");
	});

	test("a group without a row list is refused", () => {
		expect(problemsOf({ id: "p", plugins: [{ name: "a", group: true }] })).toHaveLength(1);
	});

	test("nested rows are validated too", () => {
		// A bad row inside a group is as unmountable as a bad top-level row.
		const problems = problemsOf({
			id: "p",
			plugins: [{ name: "a", group: true, config: [{ name: "b" }, { name: "" }] }],
		});
		expect(problems).toHaveLength(1);
	});

	test("the enable switch is not a validation error", () => {
		// A disabled row stays in the composition: it is how a child preset turns
		// off one of its parent's plugins, and the UI must still show it.
		expect(problemsOf({ id: "p", plugins: [{ name: "a", enabled: false }] })).toEqual([]);
	});
});
