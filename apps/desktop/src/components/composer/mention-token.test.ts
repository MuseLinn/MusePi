import { describe, expect, test } from "bun:test";
import { pastedImageMentionLabels } from "./attachment-mention-paste";
import {
	deleteMentionTokenAfter,
	deleteMentionTokenBefore,
	removeMentionTokens,
	spliceMentionToken,
	spliceMentionTokens,
} from "./mention-token";
import type { ComposerAttachment } from "./use-attachments";

const liveImages = (name: string): boolean => /^图片[1-9]\d*$/.test(name);

describe("spliceMentionTokens (paste intake)", () => {
	test("inserts every ordinal at the caret, each closing itself with a space", () => {
		expect(spliceMentionTokens("看图：", 3, 3, ["图片1", "图片2"])).toEqual({
			next: "看图：@图片1 @图片2 ",
			caret: 13,
		});
	});

	test("replaces a selection and keeps the ASCII glue rule", () => {
		expect(spliceMentionTokens("hello world", 5, 11, ["图片1"]).next).toBe("hello @图片1 ");
	});

	test("no tokens leaves the value and caret untouched", () => {
		expect(spliceMentionTokens("abc", 2, 2, [])).toEqual({ next: "abc", caret: 2 });
	});

	test("matches the single-token splice for one name", () => {
		expect(spliceMentionTokens("x", 1, 1, ["图片1"]).next).toBe(spliceMentionToken("x", 1, 1, "图片1").next);
	});
});

describe("pastedImageMentionLabels (paste intake ordinals)", () => {
	const chip = (kind: "image" | "file", name: string): ComposerAttachment =>
		({ id: 1, kind, dataUrl: "", mimeType: "", name, size: 0 }) as ComposerAttachment;

	test("continues numbering from the images staged before the batch", () => {
		const added = [chip("image", "a.png"), chip("file", "b.pdf"), chip("image", "c.png")];
		expect(pastedImageMentionLabels(added, 2)).toEqual(["图片3", "图片4"]);
	});

	test("a batch without images produces no mentions", () => {
		expect(pastedImageMentionLabels([chip("file", "b.pdf")], 4)).toEqual([]);
	});
});

describe("atomic mention deletion", () => {
	test("Backspace after the trailing space removes token + space", () => {
		const value = "看图 @图片1 然后";
		const caret = "看图 @图片1 ".length;
		expect(deleteMentionTokenBefore(value, caret, liveImages)).toEqual({
			next: "看图 然后",
			caret: 3,
		});
	});

	test("Backspace immediately after the token (no trailing space) also removes it", () => {
		const value = "看图@图片2";
		expect(deleteMentionTokenBefore(value, value.length, liveImages)).toEqual({
			next: "看图",
			caret: 2,
		});
	});

	test("Delete at the token start removes the token and its following space", () => {
		const value = "看图 @图片1 然后";
		expect(deleteMentionTokenAfter(value, 3, liveImages)).toEqual({
			next: "看图 然后",
			caret: 3,
		});
	});

	test("an unresolved token stays prose — ordinary character deletion", () => {
		expect(deleteMentionTokenBefore("mail @图片9 ", "mail @图片9 ".length, name => name === "图片1")).toBeNull();
		expect(deleteMentionTokenAfter("@draft text", 0, liveImages)).toBeNull();
	});

	test("a caret inside the token is not an atomic boundary", () => {
		expect(deleteMentionTokenBefore("@图片1", 2, liveImages)).toBeNull();
	});
});

describe("removeMentionTokens (chip removal sync)", () => {
	test("removes the token and one trailing space", () => {
		expect(removeMentionTokens("看图：@图片1 @图片2 ", "图片1")).toBe("看图：@图片2 ");
	});

	test("removes several references to the same chip", () => {
		expect(removeMentionTokens("@图片1 和 @图片1 都看", "图片1")).toBe("和 都看");
	});

	test("a token at the end takes the space before it", () => {
		expect(removeMentionTokens("看这个 @图片2", "图片2")).toBe("看这个");
	});

	test("a longer ordinal is never mistaken for a prefix", () => {
		expect(removeMentionTokens("@图片10 @图片1", "图片1")).toBe("@图片10");
	});

	test("no matching token leaves the draft untouched", () => {
		expect(removeMentionTokens("普通文本", "图片1")).toBe("普通文本");
	});
});
