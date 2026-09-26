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
 * Contract (attachment mention, Kimi desktop parity): a chip's "mention"
 * action inserts the plain-text token `@附件[名]` at the caret; the overlay
 * paints it as a pill (with hover preview / stale downgrade); the send path
 * expands it into explicit attachment references. The token lives in the
 * textarea text itself, so draft persistence survives for free — which is
 * exactly why parse/expand must round-trip names with spaces.
 */
const token = (name: string): string => makeMentionToken(name);

describe("parseMentionTokens", () => {
	test("round-trips a name containing spaces", () => {
		const t = token("screenshot 2026-09-26 final.png");
		const spans = parseMentionTokens(`看 ${t}`);
		expect(spans).toEqual([{ start: 2, end: 2 + t.length, name: "screenshot 2026-09-26 final.png" }]);
	});

	test("multiple tokens in one draft, order preserved", () => {
		const text = `${token("a.png")} 和 ${token("b c.txt")}`;
		const spans = parseMentionTokens(text);
		expect(spans).toHaveLength(2);
		expect(spans.map(s => s.name)).toEqual(["a.png", "b c.txt"]);
		expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(token("a.png"));
		expect(text.slice(spans[1]!.start, spans[1]!.end)).toBe(token("b c.txt"));
	});

	test("brackets without the 附件 prefix stay plain", () => {
		expect(parseMentionTokens("@[x] @mention[y]")).toEqual([]);
	});

	test("token cannot span lines", () => {
		expect(parseMentionTokens(`@附件[unterminated\nnext]`)).toEqual([]);
	});
});

describe("expandMentionTokens", () => {
	const attachments = [
		{ kind: "image" as const, name: "图片 一.png" },
		{ kind: "file" as const, name: "notes v2.md" },
	];

	test("image token → [图片:名] (pixels ride the images channel as always)", () => {
		expect(expandMentionTokens(`看 ${token("图片 一.png")}`, attachments)).toBe("看 [图片:图片 一.png]");
	});

	test("file token → the existing [Attachment] workspace-path reference", () => {
		expect(expandMentionTokens(`查 ${token("notes v2.md")}`, attachments)).toBe(
			"查 [Attachment] attachments/notes v2.md",
		);
	});

	test("stale token (attachment removed) stays verbatim — never rewritten silently", () => {
		const t = token("gone.png");
		expect(expandMentionTokens(`x ${t} y`, attachments)).toBe(`x ${t} y`);
	});

	test("multiple tokens expand independently in one pass", () => {
		const text = `${token("图片 一.png")}\n${token("notes v2.md")}\n${token("gone.png")}`;
		expect(expandMentionTokens(text, attachments)).toBe(
			`[图片:图片 一.png]\n[Attachment] attachments/notes v2.md\n${token("gone.png")}`,
		);
	});

	test("text without tokens passes through untouched", () => {
		expect(expandMentionTokens("普通消息 @附件 玩笑", attachments)).toBe("普通消息 @附件 玩笑");
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
	test("mention is painted as its own kind", () => {
		const t = token("a.png");
		const spans = parseHighlightSpans(t);
		expect(spans).toEqual([{ start: 0, end: t.length, kind: "mention" }]);
	});

	test("slash/bang/magic coexist on one line without bleeding into the token", () => {
		const t = token("笔记 稿.png");
		const text = `/cmd ${t} trailing !ls`;
		const spans = parseHighlightSpans(text);
		// line-leading slash painted; mid-text bang stays plain (not live
		// syntax); the mention is painted; neither swallows the other.
		expect(spans.map(s => s.kind)).toEqual(["slash", "mention"]);
		expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("/cmd");
		expect(text.slice(spans[1]!.start, spans[1]!.end)).toBe(t);
	});

	test("a magic word inside the brackets is NOT painted as magic — mention wins", () => {
		const t = token("workflowz");
		expect(parseHighlightSpans(t)).toEqual([{ start: 0, end: t.length, kind: "mention" }]);
	});
});
