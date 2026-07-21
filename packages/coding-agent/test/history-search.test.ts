import { describe, expect, it } from "vitest";
import { filterHistoryEntries } from "../src/modes/interactive/components/history-search.ts";

describe("filterHistoryEntries", () => {
	const entries = ["npm run build", "git status", "!ls -la", "npm test", "git commit -m wip"];

	it("returns entries untouched (newest-first) for an empty query", () => {
		expect(filterHistoryEntries(entries, "")).toEqual(entries);
		expect(filterHistoryEntries(entries, "   ")).toEqual(entries);
	});

	it("filters by subsequence match", () => {
		expect(filterHistoryEntries(entries, "npm")).toEqual(["npm run build", "npm test"]);
	});

	it("fuzzy-matches non-consecutive characters", () => {
		const results = filterHistoryEntries(entries, "gs");
		expect(results).toContain("git status");
		expect(results).not.toContain("npm test");
	});

	it("ranks better matches first", () => {
		const results = filterHistoryEntries(entries, "git");
		expect(results[0]).toBe("git status");
		expect(results).toHaveLength(2);
	});

	it("returns an empty list when nothing matches", () => {
		expect(filterHistoryEntries(entries, "zzzqqq")).toEqual([]);
	});
});
