import { describe, expect, test } from "bun:test";
import { findReferenceViolations, isExcludedSource } from "./verify-doc-refs";

/** A probe that resolves only the paths a test declares as real. */
function existing(...present: string[]): (repoPath: string) => boolean {
	const set = new Set(present);
	return repoPath => set.has(repoPath);
}

describe("documentation citation gate", () => {
	test("reports a citation whose target does not exist", () => {
		const source = "// See `docs/deleted.md` for the contract.";
		const violations = findReferenceViolations("a.ts", source, existing());
		expect(violations).toHaveLength(1);
		expect(violations[0]?.reference).toBe("docs/deleted.md");
		expect(violations[0]?.line).toBe(1);
	});

	test("accepts a citation whose target exists", () => {
		const source = "// See `docs/architecture.md`.";
		expect(findReferenceViolations("a.ts", source, existing("docs/architecture.md"))).toHaveLength(0);
	});

	test("ignores a documentation path inside a URL", () => {
		const source = 'const URL = "https://github.com/o/r/blob/main/docs/api.md";';
		expect(findReferenceViolations("a.ts", source, existing())).toHaveLength(0);
	});

	test("requires the extension, so a directory mention is not a citation", () => {
		const source = "// The docs/ directory holds everything.";
		expect(findReferenceViolations("a.ts", source, existing())).toHaveLength(0);
	});

	test("reports one violation per path per line", () => {
		const source = "// `docs/x.md` and again `docs/x.md`";
		expect(findReferenceViolations("a.ts", source, existing())).toHaveLength(1);
	});

	test("treats a marked citation as illustrative", () => {
		const source = ["// doc-reference-example: shape only", "// `docs/foo.md`"].join("\n");
		expect(findReferenceViolations("a.ts", source, existing())).toHaveLength(0);
	});

	test("excludes tests, built output, and vendored source", () => {
		expect(isExcludedSource("apps/desktop/test/at-completion.test.ts")).toBe(true);
		expect(isExcludedSource("packages/a/src/b.test.ts")).toBe(true);
		expect(isExcludedSource("packages/a/lib/index.js")).toBe(true);
		expect(isExcludedSource("vendor/pkg/index.ts")).toBe(true);
		expect(isExcludedSource("packages/a/src/index.ts")).toBe(false);
	});
});
