import { describe, expect, test } from "bun:test";
import { checkCssTokens, definedColorTokens } from "./check-css-tokens";

describe("checkCssTokens", () => {
	test("reports the file and line of an undefined semantic color", () => {
		const problems = checkCssTokens(
			[["bad.css", ".a { color: var(--fg); }\n.b { color: var(--color-border); }"]],
			":root { --color-text: var(--fg); }",
		);
		expect(problems).toEqual([{ file: "bad.css", line: 2, message: "undefined semantic color token --color-border" }]);
	});

	test("accepts references with fallback values when the token is defined", () => {
		const tokens = ":root {\n  --color-border: var(--border);\n}";
		expect(checkCssTokens([["ok.css", ".a { color: var(--color-border, transparent); }"]], tokens)).toEqual([]);
	});

	test("collects definitions in theme blocks as well as root", () => {
		expect([...definedColorTokens(":root { --color-text: black; }\n.dark { --color-border: white; }")]).toEqual([
			"--color-text",
			"--color-border",
		]);
	});
});
