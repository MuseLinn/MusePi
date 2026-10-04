/**
 * `check-dead-code` contract tests.
 *
 * The gate is only useful if it reads knip's report correctly and blocks growth
 * without blocking the cleanup it exists to encourage. Each case names the
 * failure it prevents.
 */
import { describe, expect, test } from "bun:test";
import { type DeadCodeEntry, diffAgainstBaseline, parseKnipReport } from "./check-dead-code";

const entry = (kind: string, file: string, symbol: string): DeadCodeEntry => ({
	kind,
	file,
	symbol,
});

describe("parseKnipReport", () => {
	test("flattens every per-file issue into one list", () => {
		// Failure mode if regressed: the report is a list of per-file groups with
		// a different array per kind, so a naive read finds nothing and the gate
		// reports zero findings forever.
		const report = {
			issues: [
				{
					file: "package.json",
					dependencies: [{ name: "left-pad" }],
					exports: [],
				},
				{
					file: "a.ts",
					exports: [{ name: "unused" }],
					types: [{ name: "Ghost" }],
				},
			],
		};
		expect(parseKnipReport(report)).toHaveLength(3);
	});

	test("ignores a file-less issue", () => {
		expect(parseKnipReport({ issues: [{ exports: [{ name: "orphan" }] }] })).toHaveLength(0);
	});

	test("survives an empty or malformed report", () => {
		expect(parseKnipReport(undefined)).toHaveLength(0);
		expect(parseKnipReport({})).toHaveLength(0);
		expect(parseKnipReport({ issues: [{ file: "a.ts" }] })).toHaveLength(0);
	});
});

describe("diffAgainstBaseline", () => {
	test("reports a finding the baseline does not contain", () => {
		// Failure mode if regressed: the gate stays green while dead exports
		// accumulate, which is the one thing it was added to prevent.
		const baseline = ["exports a.ts old"];
		const added = diffAgainstBaseline([entry("exports", "a.ts", "old"), entry("exports", "a.ts", "new")], baseline);
		expect(added).toEqual(["exports a.ts new"]);
	});

	test("passes when the finding is already baselined", () => {
		const baseline = ["exports a.ts known"];
		expect(diffAgainstBaseline([entry("exports", "a.ts", "known")], baseline)).toHaveLength(0);
	});

	test("does not report the same finding twice", () => {
		const once = [entry("exports", "a.ts", "dup")];
		expect(diffAgainstBaseline([...once, ...once], [])).toHaveLength(1);
	});

	test("keys on kind and file, not on position", () => {
		// A symbol that moved files is a new finding; a symbol that stayed put is
		// not, and the entry carries no line number precisely so that a refactor
		// does not read as new dead code.
		const baseline = ["types b.ts Ghost"];
		expect(diffAgainstBaseline([entry("types", "b.ts", "Ghost")], baseline)).toHaveLength(0);
		expect(diffAgainstBaseline([entry("types", "c.ts", "Ghost")], baseline)).toHaveLength(1);
	});

	test("distinguishes an unused type from an unused export of the same name", () => {
		const baseline = ["types a.ts Shared"];
		const added = diffAgainstBaseline([entry("exports", "a.ts", "Shared")], baseline);
		expect(added).toEqual(["exports a.ts Shared"]);
	});
});
