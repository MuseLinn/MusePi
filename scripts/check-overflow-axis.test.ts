/**
 * `check-overflow-axis` contract tests.
 *
 * The gate only earns its place if it fails on the exact defect it was written
 * for — a container that declares one scroll axis and silently gets the other
 * one as `auto` — and stays quiet on declarations that already name both axes
 * or legitimately scroll sideways from the allowlist. Each case names the
 * failure it prevents.
 */
import { describe, expect, test } from "bun:test";
import { auditOverflowAxis, HORIZONTAL_SCROLLERS, unusedAllowlistEntries } from "./check-overflow-axis";

const rules = (source: string) => auditOverflowAxis("a.css", source);

describe("auditOverflowAxis", () => {
	test("flags a vertical-only scroller — the project card's shape", () => {
		// The shipped defect: `overflow-y: auto` alone makes the other axis
		// `auto` too, so a nowrap path row grew a horizontal scrollbar on a card
		// whose content was complete.
		const problems = rules(".card-list {\n  overflow-y: auto;\n}");
		expect(problems).toHaveLength(1);
		expect(problems[0]?.selector).toBe(".card-list");
		expect(problems[0]?.axis).toBe("overflow-y");
		expect(problems[0]?.reason).toBe("missing-counterpart");
	});

	test("flags a horizontal-only scroller that is not on the allowlist", () => {
		const problems = rules(".new-strip {\n  overflow-x: auto;\n}");
		expect(problems).toHaveLength(1);
		expect(problems[0]?.reason).toBe("unlisted-horizontal-scroller");
		// The message must say what to do, or the next reader drops the scroll.
		expect(problems[0]?.detail).toContain("HORIZONTAL_SCROLLERS");
	});

	test("accepts both axes declared", () => {
		expect(rules(".list {\n  overflow-y: auto;\n  overflow-x: clip;\n}")).toHaveLength(0);
	});

	test("accepts the shorthand, which sets both axes by definition", () => {
		expect(rules(".box {\n  overflow: hidden;\n}")).toHaveLength(0);
		expect(rules(".box {\n  overflow: hidden auto;\n}")).toHaveLength(0);
	});

	test("accepts an allowlisted horizontal scroller", () => {
		const selector = Object.keys(HORIZONTAL_SCROLLERS)[0] as string;
		expect(rules(`${selector} {\n  overflow-x: auto;\n  overflow-y: clip;\n}`)).toHaveLength(0);
	});

	test("rejects an allowlist entry that stopped scrolling sideways", () => {
		// The allowlist must not become a place a bug hides: an entry whose rule
		// now clips horizontally is a stale exemption, not an intentional scroller.
		const selector = Object.keys(HORIZONTAL_SCROLLERS)[0] as string;
		const problems = rules(`${selector} {\n  overflow-x: hidden;\n  overflow-y: clip;\n}`);
		expect(problems).toHaveLength(1);
		expect(problems[0]?.reason).toBe("unused-allowlist-entry");
	});

	test("reports each selector of a selector list separately", () => {
		const problems = rules(".list-a, .list-b {\n  overflow-y: auto;\n}");
		expect(problems.map(problem => problem.selector)).toEqual([".list-a", ".list-b"]);
	});

	test("ignores declarations inside comments", () => {
		// A commented-out line is not a declaration; counting it would report a
		// defect that is not there and train everyone to ignore the gate.
		const source = "/* .old { overflow-y: auto; } */\n.list {\n  overflow-y: auto;\n  overflow-x: clip;\n}";
		expect(rules(source)).toHaveLength(0);
	});

	test("reads at-rule blocks through to the rules inside them", () => {
		const problems = rules("@media (min-width: 720px) {\n  .list {\n    overflow-y: auto;\n  }\n}");
		expect(problems).toHaveLength(1);
		expect(problems[0]?.selector).toBe(".list");
	});

	test("does not confuse overflow-x with overflow-y", () => {
		// A prefix check would accept `overflow-y` as the counterpart of
		// `overflow-x` and wave the defect through.
		const problems = rules(".list {\n  overflow-y: auto;\n  overflow-x: clip;\n  overflow-x: clip;\n}");
		expect(problems).toHaveLength(0);
	});
});

describe("unusedAllowlistEntries", () => {
	test("reports an entry whose selector no longer exists", () => {
		const problems = unusedAllowlistEntries([{ file: "a.css", source: ".other {\n  color: red;\n}" }]);
		expect(problems.map(problem => problem.selector).sort()).toEqual(Object.keys(HORIZONTAL_SCROLLERS).sort());
		for (const problem of problems) expect(problem.reason).toBe("unused-allowlist-entry");
	});

	test("stays quiet when every entry still exists", () => {
		const source = Object.keys(HORIZONTAL_SCROLLERS)
			.map(selector => `${selector} { color: red; }`)
			.join("\n");
		expect(unusedAllowlistEntries([{ file: "a.css", source }])).toHaveLength(0);
	});
});
