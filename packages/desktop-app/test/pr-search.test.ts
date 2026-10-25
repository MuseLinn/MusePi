/**
 * Unit tests for the PR/issue board search semantics (pr-center.tsx).
 *
 * The contract: a plain word filters by title substring (case-insensitive);
 * `#123` pins the list to that exact number (both `#123` and bare `123`
 * forms); a URL never filters — the panes render an "open link" row for it
 * instead, so pasting a GitHub link is a jump, not a search.
 */
import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { describe, expect, it } from "bun:test";
import { isLinkQuery, isOpenState, matchesQuery } from "../src/components/pr-center";

describe("matchesQuery", () => {
	it("passes everything on an empty or whitespace query", () => {
		expect(matchesQuery("", 42, "Fix the crash")).toBe(true);
		expect(matchesQuery("   ", 42, "Fix the crash")).toBe(true);
	});

	it("matches title case-insensitively and rejects non-substrings", () => {
		expect(matchesQuery("crash", 42, "Fix the crash")).toBe(true);
		expect(matchesQuery("CRASH", 42, "Fix the crash")).toBe(true);
		expect(matchesQuery("the crash", 42, "Fix the crash")).toBe(true);
		expect(matchesQuery("burn", 42, "Fix the crash")).toBe(false);
	});

	it("pins to the exact number for #N (and bare N), ignoring title", () => {
		expect(matchesQuery("#42", 42, "Unrelated title")).toBe(true);
		expect(matchesQuery("#42", 43, "Contains 42 in text")).toBe(false);
		expect(matchesQuery("#42", 420, "Contains 42 in text")).toBe(false);
	});

	it("treats a URL as a non-filter (never matches by itself)", () => {
		// The panes branch on isLinkQuery before filtering; matchesQuery just
		// must not crash and not pretend the URL is a title substring.
		expect(matchesQuery("https://github.com/a/b/issues/1", 1, "anything")).toBe(false);
	});
});

describe("isOpenState", () => {
	it("treats gh's uppercase and lowercase open states as open only", () => {
		expect(isOpenState("OPEN")).toBe(true);
		expect(isOpenState("open")).toBe(true);
		expect(isOpenState("CLOSED")).toBe(false);
		expect(isOpenState("MERGED")).toBe(false);
	});
});

describe("isLinkQuery", () => {
	it("accepts http(s) URLs and rejects everything else", () => {
		expect(isLinkQuery("https://github.com/a/b/pull/12")).toBe(true);
		expect(isLinkQuery("http://example.com/x")).toBe(true);
		expect(isLinkQuery("  https://github.com/a/b/issues/9 ")).toBe(true);
		expect(isLinkQuery("#12")).toBe(false);
		expect(isLinkQuery("crash")).toBe(false);
		expect(isLinkQuery("github.com/a/b")).toBe(false);
		expect(isLinkQuery("")).toBe(false);
	});
});
