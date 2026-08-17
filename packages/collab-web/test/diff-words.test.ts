import { describe, expect, it } from "bun:test";
import { diffWords, type WordDiffPart } from "../src/tool-render/diff-words";

/** Rendered marker string: `[-removed-]`, `[+added+]`, plain equal. */
function render(parts: WordDiffPart[]): string {
	return parts
		.map(p => (p.removed ? `[-${p.value}-]` : p.added ? `[+${p.value}+]` : p.value))
		.join("");
}

describe("diffWords (jsdiff/pi-natives semantics)", () => {
	it("replaces a middle word, moving boundary whitespace to keep runs", () => {
		expect(render(diffWords("a b c", "a x c"))).toBe("a [-b-][+x+] c");
	});

	it("highlights only changed tokens in a line", () => {
		expect(render(diffWords("const x = 1;", "const y = 2;"))).toBe(
			"const [-x-][+y+] = [-1-][+2+];",
		);
	});

	it("treats equal lines as a single keep run", () => {
		const parts = diffWords("same line", "same line");
		expect(parts).toHaveLength(1);
		expect(parts[0]?.value).toBe("same line");
		expect(parts[0]?.added).toBeUndefined();
		expect(parts[0]?.removed).toBeUndefined();
	});

	it("pure addition and deletion", () => {
		expect(render(diffWords("", "new content"))).toBe("[+new content+]");
		expect(render(diffWords("old content", ""))).toBe("[-old content-]");
	});

	it("replaces a whole word (template-literal style change)", () => {
		expect(render(diffWords("Hello", "${prefix}"))).toBe("[-Hello-][+${prefix}+]");
	});

	it("concatenated values reproduce the new text (minus removed runs)", () => {
		const oldT = "  return `Hello, ${name}!`;";
		const newT = "  const prefix = name ? \"Hello\" : \"Hi\";";
		const parts = diffWords(oldT, newT);
		const concat = parts
			.filter(p => !p.removed)
			.map(p => p.value)
			.join("");
		expect(concat).toBe(newT);
	});

	it("handles empty inputs", () => {
		expect(diffWords("", "")).toHaveLength(0);
	});
});
