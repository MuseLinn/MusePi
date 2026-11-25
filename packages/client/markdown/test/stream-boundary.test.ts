import { describe, expect, it } from "bun:test";
import { Marked } from "@musepi/pi-utils/marked";
import { type LexicalRenderer, lexedText, NO_PREFIX, renderStreamingBlocks } from "../src/stream-boundary";

const md = new Marked({ gfm: true, breaks: true });

/** A renderer over the fork, exactly as the transcript wires it. */
const renderer: LexicalRenderer = {
	normalize(text) {
		if (text.includes("\r")) return null;
		return text.includes("\t") ? text.replaceAll("\t", "    ") : text;
	},
	lex: source => lexedText(md.lexer(source)),
	parseTokens(stream, from, to) {
		// The fork's parser takes a token array; slicing keeps each block's markup
		// independent (block tokens do not depend on each other's neighbors).
		return md.parser(stream.tokens.slice(from, to) as never);
	},
	parseWhole: source => md.parse(source, { async: false }),
	listMayContinueAt: () => true,
};

function whole(text: string): string {
	return md.parse(text, { async: false });
}

/** Feed text one character at a time, as streaming does, and keep the prefix. */
function stream(text: string): string[] {
	const out: string[] = [];
	let prefix = NO_PREFIX;
	for (let i = 1; i <= text.length; i++) {
		const slice = text.slice(0, i);
		const result = renderStreamingBlocks(slice, prefix, renderer);
		prefix = result.prefix;
		out.push(result.html);
	}
	return out;
}

/**
 * The frozen-prefix split is only worth having if it is INVISIBLE: every
 * intermediate render must equal a full parse of the same text, byte for byte.
 * A boundary guessed wrong shows up here as a mismatch, not as a subtle layout
 * difference in a running transcript.
 */
describe("lexer-derived streaming boundaries", () => {
	const cases: Array<[string, string]> = [
		["paragraphs", "first paragraph\n\nsecond paragraph\n\nthird"],
		["a table", "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter"],
		["a fence", "before\n\n```ts\nconst x = 1;\n```\n\nafter"],
		["a list", "intro\n\n- one\n- two\n\nafter"],
		["a list continuing across a blank line", "intro\n\n- one\n\n- two\n\nafter"],
		["display math", "intro\n\n$$\ny = a + b\n$$\n\nafter"],
		["nested list", "intro\n\n1. a\n   - b\n   - c\n\n2. d\n\nafter"],
		["heading then prose", "# Title\n\nbody text\n\nmore"],
		["hard breaks", "line one  \nline two\n\nnext"],
	];

	for (const [name, text] of cases) {
		it(`renders "${name}" identically at every prefix`, () => {
			const frames = stream(text);
			for (let i = 0; i < frames.length; i++) {
				expect(frames[i], `prefix of length ${i + 1}`).toBe(whole(text.slice(0, i + 1)));
			}
		});
	}

	it("falls back to the whole text when a reference definition appears", () => {
		// The definition resolves a link inside the already-frozen prefix, so the
		// split cannot reproduce the full parse.
		const text = "see [x][1]\n\n[1]: https://example.com\n\ntail";
		const frames = stream(text);
		expect(frames.at(-1)).toBe(whole(text));
	});

	it("falls back when the text carries a carriage return", () => {
		const text = "a\r\n\r\nb";
		const result = renderStreamingBlocks(text, NO_PREFIX, renderer);
		expect(result.html).toBe(whole(text));
		expect(result.prefix).toBe(NO_PREFIX);
	});

	it("freezes something for a long streamed reply", () => {
		const text = Array.from({ length: 20 }, (_, i) => `paragraph ${i}`).join("\n\n");
		let prefix = NO_PREFIX;
		prefix = renderStreamingBlocks(text, prefix, renderer).prefix;
		// The frozen prefix covers real blocks, not just the last one.
		expect(prefix.source.length).toBeGreaterThan(text.length / 2);
	});
});
