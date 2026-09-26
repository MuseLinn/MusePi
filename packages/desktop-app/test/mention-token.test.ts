import "./dom-shim";
import { describe, expect, test } from "bun:test";
import { parseHighlightSpans } from "../src/components/composer/input-highlight";
import {
	expandMentionTokens,
	makeMentionToken,
	parseMentionTokens,
	spliceMentionToken,
} from "../src/components/composer/mention-token";

/**
 * Contract (attachment mention, Kimi desktop parity, v2 grammar): a chip's
 * "mention" action inserts the plain-text token `@名` at the caret. A
 * `@` + whitespace/bracket/slash-free run is a CANDIDATE; it is a MENTION
 * only when 名字 exactly matches a chip staged in the composer — that same
 * gate drives both the overlay paint (via resolveMention) and the send-path
 * expansion, so an unmatched token is plain text end to end: never painted,
 * never rewritten on send. A run followed by `/` or `\` is a path and
 * produces no candidate at all (bare-`@path` TUI semantics preserved).
 */
const token = (name: string): string => makeMentionToken(name);

const resolver =
	(...names: string[]) =>
	(name: string) =>
		names.includes(name) ? { kind: "image" as const, name } : null;

describe("parseMentionTokens", () => {
	test("parses an @name candidate", () => {
		const t = token("a.png");
		const spans = parseMentionTokens(`看 ${t}`);
		expect(spans).toEqual([{ start: 2, end: 2 + t.length, name: "a.png" }]);
	});

	test("multiple candidates in one draft, order preserved", () => {
		const text = `${token("a.png")} 和 ${token("b.txt")}`;
		const spans = parseMentionTokens(text);
		expect(spans).toHaveLength(2);
		expect(spans.map(s => s.name)).toEqual(["a.png", "b.txt"]);
		expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(token("a.png"));
		expect(text.slice(spans[1]!.start, spans[1]!.end)).toBe(token("b.txt"));
	});

	test("paths with a slash/backslash after the run never parse (bare-@path stays plain)", () => {
		expect(parseMentionTokens("@src/foo.ts @a\\b @/root")).toEqual([]);
	});

	test("candidates end at whitespace/brackets and never cross lines", () => {
		expect(parseMentionTokens("@a b @c\nd @e[x]").map(s => s.name)).toEqual(["a", "c", "e"]);
	});
});

describe("expandMentionTokens", () => {
	const attachments = [
		{ kind: "image" as const, name: "图一.png" },
		{ kind: "file" as const, name: "notes-v2.md" },
	];

	test("image token → [图片:名] (pixels ride the images channel as always)", () => {
		expect(expandMentionTokens(`看 ${token("图一.png")}`, attachments)).toBe("看 [图片:图一.png]");
	});

	test("file token → the existing [Attachment] workspace-path reference", () => {
		expect(expandMentionTokens(`查 ${token("notes-v2.md")}`, attachments)).toBe(
			"查 [Attachment] attachments/notes-v2.md",
		);
	});

	test("duplicate chip names: the FIRST match wins", () => {
		const dupes = [
			{ kind: "image" as const, name: "dup.png" },
			{ kind: "file" as const, name: "dup.png" },
		];
		expect(expandMentionTokens(token("dup.png"), dupes)).toBe("[图片:dup.png]");
	});

	test("token whose attachment is gone stays verbatim — never rewritten silently", () => {
		const t = token("gone.png");
		expect(expandMentionTokens(`x ${t} y`, attachments)).toBe(`x ${t} y`);
	});

	test("path-like text never expands even when a segment names a chip", () => {
		expect(expandMentionTokens("check @src/notes-v2.md", attachments)).toBe("check @src/notes-v2.md");
	});

	test("multiple tokens expand independently in one pass", () => {
		const text = `${token("图一.png")}\n${token("notes-v2.md")}\n${token("gone.png")}`;
		expect(expandMentionTokens(text, attachments)).toBe(
			`[图片:图一.png]\n[Attachment] attachments/notes-v2.md\n${token("gone.png")}`,
		);
	});

	test("text without matching tokens passes through untouched", () => {
		expect(expandMentionTokens("普通消息 @someone 玩笑", attachments)).toBe("普通消息 @someone 玩笑");
	});
});

describe("spliceMentionToken", () => {
	test("inserts at the caret, keeps the tail, reports the caret after the token", () => {
		const { next, caret } = spliceMentionToken("前后", 1, 1, "a.png");
		expect(next).toBe(`前${token("a.png")} 后`);
		expect(caret).toBe(`前${token("a.png")} `.length);
	});

	test("replaces the selection", () => {
		const { next } = spliceMentionToken("keep <sel> keep", 5, 11, "a.png");
		expect(next).toBe(`keep ${token("a.png")} keep`);
	});

	test("glues a space after a preceding word so the token never fuses with it", () => {
		const { next } = spliceMentionToken("word", 4, 4, "a.png");
		expect(next).toBe(`word ${token("a.png")} `);
	});

	test("no glue at the start of the draft", () => {
		expect(spliceMentionToken("", 0, 0, "a.png").next).toBe(`${token("a.png")} `);
	});
});

describe("parseHighlightSpans × mention", () => {
	test("a resolving candidate is painted as a mention", () => {
		const t = token("a.png");
		expect(parseHighlightSpans(t, resolver("a.png"))).toEqual([{ start: 0, end: t.length, kind: "mention" }]);
	});

	test("an unresolved candidate is NOT painted — paint is gated on the live chips", () => {
		expect(parseHighlightSpans("@someone", resolver("a.png"))).toEqual([]);
	});

	test("a path after the @ never paints even when a segment names a chip", () => {
		expect(parseHighlightSpans("@src/a.png", resolver("a.png", "src"))).toEqual([]);
	});

	test("slash/bang/magic coexist on one line without bleeding into the token", () => {
		const t = token("笔记.png");
		const text = `/cmd ${t} trailing !ls`;
		const spans = parseHighlightSpans(text, resolver("笔记.png"));
		// line-leading slash painted; mid-text bang stays plain (not live
		// syntax); the mention is painted; neither swallows the other.
		expect(spans.map(s => s.kind)).toEqual(["slash", "mention"]);
		expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("/cmd");
		expect(text.slice(spans[1]!.start, spans[1]!.end)).toBe(t);
	});

	test("an attachment named like a magic word wins the region; without the chip the keyword paints", () => {
		const t = token("workflowz");
		expect(parseHighlightSpans(t, resolver("workflowz"))).toEqual([{ start: 0, end: t.length, kind: "mention" }]);
		// without the chip only the keyword paints — and it starts after the @.
		expect(parseHighlightSpans(t, resolver())).toEqual([{ start: 1, end: t.length, kind: "magic" }]);
	});
});
