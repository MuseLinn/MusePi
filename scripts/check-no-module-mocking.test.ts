/**
 * `check-no-module-mocking` contract tests.
 *
 * The gate exists because the rule was prose in AGENTS.md and a test broke it
 * anyway. Two things have to hold: a real call is caught, and the several ways a
 * file can merely mention the API are not.
 */
import { describe, expect, test } from "bun:test";
import { findModuleMocking } from "./check-no-module-mocking";

describe("findModuleMocking", () => {
	test("flags the call with its line", () => {
		// Failure mode if regressed: the rule is prose again, and the next
		// mock.module() silently rewrites the registry for every later file.
		const source = ["const a = 1;", 'mock.module("../src/x", () => ({ a }));', ""].join("\n");
		const hits = findModuleMocking("x.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(2);
	});

	test("flags a call written with whitespace inside the member access", () => {
		const source = 'mock . module("../src/x", () => ({}));\n';
		expect(findModuleMocking("x.test.ts", source)).toHaveLength(1);
	});

	test("ignores the name inside a comment", () => {
		const source = ["// never use mock.module() here — see AGENTS.md", "const a = 1;", ""].join("\n");
		expect(findModuleMocking("x.test.ts", source)).toHaveLength(0);
	});

	test("ignores the name inside a doc comment", () => {
		const source = ["/**", " * Replaces mock.module() with a spy.", " */", "const a = 1;", ""].join("\n");
		expect(findModuleMocking("x.test.ts", source)).toHaveLength(0);
	});

	test("ignores the name inside a string literal", () => {
		// A test that documents the ban has to spell the call out as a string.
		// If this were reported, the gate could not even test itself.
		const source = 'const doc = "never call mock.module() here";' + "\n";
		expect(findModuleMocking("x.test.ts", source)).toHaveLength(0);
	});

	test("ignores an unrelated mock whose name merely ends in module", () => {
		const source = 'mock.moduleRegistry("../src/x");\n';
		expect(findModuleMocking("x.test.ts", source)).toHaveLength(0);
	});

	test("flags every occurrence", () => {
		const source = 'mock.module("../a", () => ({}));\nmock.module("../b", () => ({}));\n';
		expect(findModuleMocking("x.test.ts", source).map(h => h.line)).toEqual([1, 2]);
	});
});
