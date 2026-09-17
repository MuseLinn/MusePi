import { describe, expect, test } from "bun:test";
import { checkRadiusTokens } from "./check-radius-tokens";

/**
 * The radius ladder gate (design spec 2026-09-17). The interesting cases are
 * the allowlist boundaries: pill/circle shapes stay legal, generated
 * tailwind output stays out of scope, and the ladder tokens must exist —
 * `--radius-md` was referenced 13 times before anyone noticed it was never
 * defined, which is exactly the failure mode this gate exists for.
 */

const CLEAN = [
	"packages/a/x.css",
	`
.card {
	border-radius: var(--radius-lg);
}
.pill {
	border-radius: 999px;
}
.circle {
	border-radius: 50%;
}
.none {
	border-radius: 0;
}
.asym {
	border-radius: var(--radius-xl) var(--radius-xl) 0 0;
}
.hairline {
	border-radius: 1.5px;
}
`,
];

describe("checkRadiusTokens", () => {
	test("accepts token references and the semantic pill/circle shapes", () => {
		const result = checkRadiusTokens(CLEAN.map(c => ["a.css", c]));
		expect(result.ok).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	test("flags a literal px radius", () => {
		const result = checkRadiusTokens([["a.css", ".card {\n\tradius-ok: 1;\n\tborder-radius: 10px;\n}\n"]]);
		expect(result.ok).toBe(false);
		expect(result.violations[0]?.value).toBe("10px");
		expect(result.violations[0]?.line).toBe(3);
	});

	test("flags a literal radius inside a multi-value declaration", () => {
		const result = checkRadiusTokens([["a.css", ".b {\n\tborder-radius: 8px 0 0 8px;\n}\n"]]);
		expect(result.ok).toBe(false);
		expect(result.violations[0]?.value).toBe("8px 0 0 8px");
	});

	test("the real tokens.css defines the whole ladder (guards against re-deleting a step)", () => {
		const result = checkRadiusTokens([["a.css", ".x {\n\tborder-radius: var(--radius-lg);\n}\n"]]);
		expect(result.missingTokens).toEqual([]);
	});

	test("the real tree passes (guards against regression by a new literal)", async () => {
		// Hermetic-ish: read-only walk of the two packages, same scope as main().
		const fs = await import("node:fs");
		const path = await import("node:path");
		const files: Array<[string, string]> = [];
		const walk = (dir: string): void => {
			for (const name of fs.readdirSync(dir)) {
				const p = path.join(dir, name);
				if (fs.statSync(p).isDirectory()) walk(p);
				else if (name.endsWith(".css") && !name.endsWith(".out.css")) files.push([p, fs.readFileSync(p, "utf8")]);
			}
		};
		for (const root of ["packages/desktop-app/src", "packages/guest-client/src"]) walk(root);
		const result = checkRadiusTokens(files);
		expect(result.violations).toEqual([]);
	});
});
