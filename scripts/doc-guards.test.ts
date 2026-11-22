import { describe, expect, test } from "bun:test";
import { wordCount } from "./check-doc-budgets";
import { countDatedMarkers } from "./check-doc-hygiene";

describe("documentation guards", () => {
	test("counts dated decision markers, not dates in prose", () => {
		expect(countDatedMarkers("- **Card (2026-11-08)**: shipped.")).toBe(1);
		expect(countDatedMarkers("Two dates (2026-11-08) and (2026-11-09).")).toBe(2);
		expect(countDatedMarkers("A version 2026.11 is not a dated decision.")).toBe(0);
	});

	test("counts whitespace-separated words", () => {
		expect(wordCount("one two\nthree")).toBe(3);
		expect(wordCount("   ")).toBe(0);
	});
});
