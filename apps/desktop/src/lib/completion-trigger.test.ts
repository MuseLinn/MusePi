import { describe, expect, test } from "bun:test";
import { currentLine, isTokenTrigger, lastTokenIndex, tokenQuery } from "./completion-trigger";

describe("isTokenTrigger", () => {
	test("line start always triggers", () => {
		expect(isTokenTrigger("/clear", 0)).toBe(true);
		expect(isTokenTrigger("@file", 0)).toBe(true);
	});

	test("whitespace, CJK body text and punctuation trigger", () => {
		expect(isTokenTrigger("请看 @文件", 3)).toBe(true); // space
		expect(isTokenTrigger("请看@文件", 2)).toBe(true); // CJK directly after
		expect(isTokenTrigger("（@组件", 1)).toBe(true); // full-width paren
		expect(isTokenTrigger(",@x", 1)).toBe(true); // ASCII punctuation
		expect(isTokenTrigger("请继续/", 3)).toBe(true); // trailing slash after CJK
	});

	test("ASCII word characters do NOT trigger (emails, paths, identifiers)", () => {
		expect(isTokenTrigger("foo@bar", 3)).toBe(false);
		expect(isTokenTrigger("src/foo", 3)).toBe(false);
		expect(isTokenTrigger("a1/", 2)).toBe(false);
		expect(isTokenTrigger("under_score@x", 11)).toBe(false);
	});
});

describe("lastTokenIndex", () => {
	test("picks the last triggering occurrence", () => {
		// The first "@" is an email-ish token; the second one opens the panel.
		expect(lastTokenIndex("foo@bar @baz", "@")).toBe(8);
	});

	test("returns -1 when every occurrence is glued to a word char", () => {
		expect(lastTokenIndex("foo@bar", "@")).toBe(-1);
		expect(lastTokenIndex("src/foo", "/")).toBe(-1);
	});

	test("scans past glued occurrences to an earlier free one", () => {
		// "a/b" is path-ish, then a free "/" at line start-ish position 4.
		expect(lastTokenIndex("see /a/b", "/")).toBe(4);
		expect(lastTokenIndex("see /a/b", "/") === 4).toBe(true);
		// "cd /a" then "x/y": last free "/" is the one before "a".
		expect(lastTokenIndex("cd /a x/y", "/")).toBe(3);
	});
});

describe("currentLine", () => {
	test("first line starts at 0", () => {
		expect(currentLine("请继续/")).toEqual({ line: "请继续/", lineStart: 0 });
	});

	test("multi-line resolves the caret's line", () => {
		expect(currentLine("first\nsecond/@")).toEqual({ line: "second/@", lineStart: 6 });
	});
});

describe("tokenQuery", () => {
	test("mid-line slash after body text opens with the tail as query (#17)", () => {
		// The regression: "请继续/" used to rank against the whole sentence.
		expect(tokenQuery("请继续/", "/")).toEqual({ query: "", anchor: 3 });
		expect(tokenQuery("请继续/cl", "/")).toEqual({ query: "cl", anchor: 3 });
	});

	test("line-leading slash still works (the old behaviour)", () => {
		expect(tokenQuery("/cl", "/")).toEqual({ query: "cl", anchor: 0 });
	});

	test("space after the token closes the panel", () => {
		expect(tokenQuery("/clear then do X", "/")).toBeNull();
		expect(tokenQuery("请看 @文件 里面", "@")).toBeNull();
	});

	test("path-ish and email-ish forms stay closed", () => {
		expect(tokenQuery("src/foo", "/")).toBeNull();
		expect(tokenQuery("foo@bar", "@")).toBeNull();
	});

	test("mentions trigger after CJK without a space (already-fixed @ parity)", () => {
		expect(tokenQuery("请看@文", "@")).toEqual({ query: "文", anchor: 2 });
	});
});
