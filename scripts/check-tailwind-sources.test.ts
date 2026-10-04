/**
 * `check-tailwind-sources` contract tests.
 *
 * The gate exists because a `@source` glob matching nothing is skipped in
 * silence. Each case names the failure it prevents: a green build that quietly
 * strips every Tailwind class from the renderer.
 */
import { describe, expect, test } from "bun:test";
import { checkTailwindSources } from "./check-tailwind-sources";

/** Pretend only these fixed prefixes exist. */
const exists =
	(existing: string[]) =>
	(candidate: string): boolean =>
		existing.includes(candidate);

describe("checkTailwindSources", () => {
	test("accepts globs whose fixed prefix exists", () => {
		const source = ['@import "tailwindcss";', '@source "../**/*.{ts,tsx}";', ""].join("\n");
		expect(checkTailwindSources("a.css", source, exists([".."]))).toHaveLength(0);
	});

	test("reports a glob pointing at a directory that does not exist", () => {
		// Failure mode if regressed: the renderer's own sources went one level too
		// deep, the scan found nothing, and the regenerated sheet had zero
		// utilities while every build still exited 0.
		const source = ['@source "./src/**/*.{ts,tsx}";', ""].join("\n");
		const problems = checkTailwindSources("tailwind.css", source, exists([".."]));
		expect(problems).toHaveLength(1);
		expect(problems[0]?.glob).toBe("./src/**/*.{ts,tsx}");
		expect(problems[0]?.line).toBe(1);
	});

	test("reports a renamed package", () => {
		const source = '@source "../guest-client/src/**/*.{ts,tsx}";\n';
		const problems = checkTailwindSources("tailwind.css", source, exists(["../client-core/src"]));
		expect(problems).toHaveLength(1);
		expect(problems[0]?.message).toBe("matches no file");
	});

	test("ignores remote sources", () => {
		const source = '@source "https://example.com/tokens.css";\n';
		expect(checkTailwindSources("a.css", source, () => false)).toHaveLength(0);
	});

	test("reports every bad declaration with its own line", () => {
		const source = ['@source "./a/**";', '@source "./b/**";', ""].join("\n");
		const problems = checkTailwindSources("a.css", source, () => false);
		expect(problems.map(p => p.line)).toEqual([1, 2]);
	});

	test("accepts a glob with no wildcard", () => {
		const source = '@source "../tokens.css";\n';
		expect(checkTailwindSources("a.css", source, exists(["../tokens.css"]))).toHaveLength(0);
	});
});
