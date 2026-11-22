/**
 * `check-dom-assertions` contract tests.
 *
 * The ban exists because a failing `expect(<DOM node>).toBeNull()` stalls Bun's
 * reporter instead of printing a diff: measured here, a guard that should fail in
 * milliseconds reported "timed out after 5000ms" and the process took 69.8s.
 * These cases pin what the ban catches and — just as important — what it must
 * leave alone, because a ban that also fires on the boolean replacement would
 * forbid its own fix.
 */
import { describe, expect, test } from "bun:test";
import { collectDomAssertions, countByFile, growth } from "./check-dom-assertions";

const sites = (source: string) => collectDomAssertions("a.test.tsx", source);

describe("collectDomAssertions", () => {
	test("flags toBeNull on a querySelector result", () => {
		const found = sites('expect(host.querySelector(".gui-row")).toBeNull();');
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe('expect(host.querySelector(".gui-row")).toBeNull()');
	});

	test("flags the negative form too — it serialises the same node", () => {
		// `.not.toBeNull()` fails when the node is PRESENT, and prints the node.
		// Leaving it legal would keep the stall for the more common assertion.
		expect(sites('expect(host.querySelector(".gui-row")).not.toBeNull();')).toHaveLength(1);
	});

	test("flags toBeDefined on a DOM query", () => {
		expect(sites('expect(document.getElementById("root")).toBeDefined();')).toHaveLength(1);
	});

	test("flags a node reached through a child accessor", () => {
		expect(sites("expect(list.firstElementChild).toBeNull();")).toHaveLength(1);
	});

	test("reads a nested call as one argument", () => {
		// A selector may contain parentheses; stopping at the first `)` would read
		// the argument as truncated and miss the matcher.
		const found = sites('expect(host.querySelector(".a[data-x=\\"(1)\\"]")).toBeNull();');
		expect(found).toHaveLength(1);
	});

	test("does not fire on the boolean replacement", () => {
		// The fix must be legal, or the ban forbids its own remedy.
		expect(sites('expect(host.querySelector(".gui-row") === null).toBe(true);')).toEqual([]);
		expect(sites('expect(host.querySelector(".gui-row") !== null).toBe(true);')).toEqual([]);
	});

	test("does not fire on a length assertion", () => {
		expect(sites('expect(host.querySelectorAll(".gui-row").length).toBe(0);')).toEqual([]);
	});

	test("does not fire on a non-DOM subject", () => {
		// `toBeNull` on a plain value prints a value, not a node: no stall.
		expect(sites("expect(readCachedCatalog(key)).toBeNull();")).toEqual([]);
		expect(sites("expect(payload.error).toBeUndefined();")).toEqual([]);
	});

	test("does not fire on another matcher over a node", () => {
		expect(sites('expect(host.querySelector(".gui-row")).toBeTruthy();')).toEqual([]);
		expect(sites('expect(host.querySelector(".gui-row")?.className).toContain("gui-row");')).toEqual([]);
	});

	test("reports the line of the assertion", () => {
		const source = [
			'import { test } from "bun:test";',
			"",
			'test("x", () => {',
			'\texpect(host.querySelector(".a")).toBeNull();',
			"});",
		].join("\n");
		expect(sites(source)[0]?.line).toBe(4);
	});
});

describe("growth", () => {
	test("fails a file that gained a site", () => {
		const violations = growth({ "a.test.ts": 3 }, { "a.test.ts": 2 });
		expect(violations).toEqual([{ file: "a.test.ts", count: 3, allowed: 2 }]);
	});

	test("treats a file with no baseline entry as allowing none", () => {
		expect(growth({ "new.test.ts": 1 }, {})).toEqual([{ file: "new.test.ts", count: 1, allowed: 0 }]);
	});

	test("does not fail a shrink, so paying the debt needs no bookkeeping", () => {
		expect(growth({ "a.test.ts": 1 }, { "a.test.ts": 5 })).toEqual([]);
	});
});

describe("countByFile", () => {
	test("counts per file, which is the granularity the baseline records", () => {
		const counts = countByFile([
			{ file: "a.test.ts", line: 1, text: "x" },
			{ file: "a.test.ts", line: 9, text: "y" },
			{ file: "b.test.ts", line: 3, text: "z" },
		]);
		expect(counts).toEqual({ "a.test.ts": 2, "b.test.ts": 1 });
	});
});
