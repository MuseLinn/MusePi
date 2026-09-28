import "./dom-shim";
import { describe, expect, test } from "bun:test";
import { parseHighlightSpans } from "../src/components/composer/input-highlight";
import {
	expandMentionTokens,
	makeMentionToken,
	mentionTokenName,
	parseMentionTokens,
	resolveMentionChip,
	retargetMentionTokens,
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

/**
 * Ordinal tokens (v3, Kimi desktop parity): chip-inserted mentions are
 * `@图片N` / `@文件N` — N = 1-based position among same-kind chips. They
 * exist because pasted screenshots all arrive as "image.png": name tokens
 * resolve to the FIRST same-named chip, so every mention pointed at the
 * first image (user report 2026-09-28). Chip-order changes rewrite the
 * numbers in the draft (retargetMentionTokens) so a token keeps pointing
 * at the SAME chip; a removed chip's token degrades to its name form.
 */
const oChip = (id: number, kind: "image" | "file", name: string) => ({ id, kind, name });

describe("resolveMentionChip × ordinal tokens", () => {
	const chips = [oChip(1, "image", "image.png"), oChip(2, "image", "image.png"), oChip(3, "file", "notes.md")];

	test("图片N resolves to the Nth IMAGE chip — duplicate names can't hijack it", () => {
		expect(resolveMentionChip("图片1", chips)?.chip.id).toBe(1);
		// The regression: both chips are named image.png; the second mention
		// must reach the SECOND chip, not the first name match.
		expect(resolveMentionChip("图片2", chips)?.chip.id).toBe(2);
	});

	test("文件N numbers files independently of images", () => {
		const hit = resolveMentionChip("文件1", chips);
		expect(hit?.chip.id).toBe(3);
		expect(hit?.ordinal).toBe(1);
	});

	test("out-of-range ordinals and unknown names stay plain text", () => {
		expect(resolveMentionChip("图片3", chips)).toBeNull();
		expect(resolveMentionChip("文件0", chips)).toBeNull();
		expect(resolveMentionChip("gone.png", chips)).toBeNull();
	});

	test("name tokens still resolve (legacy drafts, hand-typed names)", () => {
		const hit = resolveMentionChip("notes.md", chips);
		expect(hit?.via).toBe("name");
		expect(hit?.chip.id).toBe(3);
	});
});

describe("mentionTokenName", () => {
	test("the mention button inserts the chip's CURRENT ordinal label", () => {
		const chips = [oChip(1, "image", "a.png"), oChip(2, "file", "b.pdf"), oChip(3, "image", "c.png")];
		expect(mentionTokenName(chips, 3)).toBe("图片2");
		expect(mentionTokenName(chips, 2)).toBe("文件1");
		expect(mentionTokenName(chips, 99)).toBeNull();
	});
});

describe("expandMentionTokens × ordinal tokens", () => {
	const chips = [oChip(1, "image", "image.png"), oChip(2, "image", "image.png"), oChip(3, "file", "notes.md")];

	test("image ordinal expands to the positional [图片 N] reference", () => {
		// The wire images ride in chip order, so [图片 2] is the SECOND
		// image — the duplicate-name case that name tokens got wrong.
		expect(expandMentionTokens("对比 @图片1 和 @图片2", chips)).toBe("对比 [图片 1] 和 [图片 2]");
	});

	test("file ordinal expands to the workspace-path reference of the Nth file", () => {
		expect(expandMentionTokens("@文件1", chips)).toBe("[Attachment] attachments/notes.md");
	});
});

describe("retargetMentionTokens (chip-order changes renumber the draft)", () => {
	const prev = [oChip(1, "image", "a.png"), oChip(2, "image", "b.png"), oChip(3, "image", "c.png")];

	test("a reorder keeps tokens pointing at the SAME chip", () => {
		// Drag c.png to the front: [a, b, c] → [c, a, b].
		const next = [prev[2]!, prev[0]!, prev[1]!];
		expect(retargetMentionTokens("@图片1 与 @图片3", prev, next)).toBe("@图片2 与 @图片1");
	});

	test("removing a chip shifts later ordinals down", () => {
		const next = prev.filter(c => c.id !== 1);
		expect(retargetMentionTokens("@图片2", prev, next)).toBe("@图片1");
	});

	test("a removed chip's token degrades to its name form — never silently re-points at the next chip", () => {
		const next = prev.filter(c => c.id !== 2);
		// b.png is gone: @图片2 must NOT come to mean c.png.
		expect(retargetMentionTokens("看 @图片2", prev, next)).toBe("看 @b.png");
	});

	test("name tokens, paths and prose pass through untouched", () => {
		const next = [prev[2]!, prev[0]!, prev[1]!];
		const text = "@a.png 和 @src/a.png 和 @someone 和 @图片1";
		expect(retargetMentionTokens(text, prev, next)).toBe("@a.png 和 @src/a.png 和 @someone 和 @图片2");
	});

	test("drafts without ordinal tokens are returned by reference", () => {
		expect(retargetMentionTokens("plain @a.png", prev, [])).toBe("plain @a.png");
	});
});
