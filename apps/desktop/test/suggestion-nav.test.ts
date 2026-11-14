import { describe, expect, test } from "bun:test";
import { stepSuggestionIndex } from "../src/lib/suggestion-nav";

/**
 * Address-bar suggestion keyboard navigation (openchamber BrowserToolbar
 * parity). External contract: ↑/↓ walk the list from "nothing selected"
 * (-1); one extra keystroke past either end wraps through -1 so the typed
 * address is always one ↓/↑ away; Enter opens the highlighted entry (the
 * component maps index ≥ 0 → suggestions[index].url, covered by wiring).
 */
describe("stepSuggestionIndex", () => {
	const count = 3;

	test("ArrowDown from nothing-selected lands on the first suggestion", () => {
		expect(stepSuggestionIndex(-1, "ArrowDown", count)).toBe(0);
	});

	test("ArrowDown walks forward", () => {
		expect(stepSuggestionIndex(0, "ArrowDown", count)).toBe(1);
		expect(stepSuggestionIndex(1, "ArrowDown", count)).toBe(2);
	});

	test("ArrowDown past the last suggestion wraps through nothing-selected", () => {
		expect(stepSuggestionIndex(2, "ArrowDown", count)).toBe(-1);
	});

	test("ArrowUp walks backward", () => {
		expect(stepSuggestionIndex(2, "ArrowUp", count)).toBe(1);
		expect(stepSuggestionIndex(1, "ArrowUp", count)).toBe(0);
	});

	test("ArrowUp from the first suggestion returns to nothing-selected", () => {
		expect(stepSuggestionIndex(0, "ArrowUp", count)).toBe(-1);
	});

	test("ArrowUp from nothing-selected wraps to the last suggestion", () => {
		expect(stepSuggestionIndex(-1, "ArrowUp", count)).toBe(2);
	});

	test("empty list never highlights", () => {
		expect(stepSuggestionIndex(-1, "ArrowDown", 0)).toBe(-1);
		expect(stepSuggestionIndex(0, "ArrowDown", 0)).toBe(-1);
	});

	test("single-entry list toggles between it and nothing-selected", () => {
		expect(stepSuggestionIndex(-1, "ArrowDown", 1)).toBe(0);
		expect(stepSuggestionIndex(0, "ArrowDown", 1)).toBe(-1);
		expect(stepSuggestionIndex(-1, "ArrowUp", 1)).toBe(0);
	});
});
