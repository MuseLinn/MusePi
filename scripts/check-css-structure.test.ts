/**
 * `check-css-structure` contract tests.
 *
 * The gate is only worth its place if it fails on the exact defect it was written
 * for — a stylesheet whose block never closes — and stays quiet on the braces
 * that legitimately appear inside strings and comments. Each case names the
 * failure it prevents.
 */
import { describe, expect, test } from "bun:test";
import { checkCssStructure } from "./check-css-structure";

describe("checkCssStructure", () => {
	test("reports the opening line of a block that never closes", () => {
		// Failure mode if regressed: the two stylesheets that shipped this defect
		// reached production half-applied, because nothing in the tree objected.
		//
		// Only the outermost is named. When two blocks are left open the inner one
		// is almost always a consequence of the outer one, so reporting both would
		// bury the line a reader has to edit under a line that closes itself.
		const problems = checkCssStructure("a.css", ".one {\n  color: red;\n.two {\n  color: blue;\n");
		expect(problems).toHaveLength(1);
		expect(problems[0]?.line).toBe(1);
		expect(problems[0]?.message).toBe("opening brace never closed");
	});

	test("reports a stray closing brace", () => {
		const problems = checkCssStructure("a.css", ".one {\n  color: red;\n}\n}\n");
		expect(problems).toHaveLength(1);
		expect(problems[0]?.message).toBe("closing brace with no opening brace");
		expect(problems[0]?.line).toBe(4);
	});

	test("accepts a balanced stylesheet", () => {
		const source = "@media (min-width: 720px) {\n  .grid {\n    columns: 1fr 1fr;\n  }\n}\n";
		expect(checkCssStructure("a.css", source)).toHaveLength(0);
	});

	test("does not count braces inside strings or comments", () => {
		// Failure mode if regressed: reporting a defect that is not there trains
		// everyone to ignore the gate, which is how it stops being a gate.
		const source = [
			".a::after {",
			'  content: "}";',
			"  /* a comment with { and } */",
			"}",
			'.b { content: "{\\"}"; }',
			"",
		].join("\n");
		expect(checkCssStructure("a.css", source)).toHaveLength(0);
	});

	test("tracks the line number across a multi-line block", () => {
		const problems = checkCssStructure("a.css", "/* header\n * more\n */\n.a {\n  color: red;\n");
		expect(problems).toHaveLength(1);
		expect(problems[0]?.line).toBe(4);
	});
});
