import { describe, expect, test } from "bun:test";
import { moveTabBefore } from "../src/lib/terminal-tab-order";

describe("moveTabBefore", () => {
	const tabs = [0, 1, 2, 3].map(key => ({ key }));

	test("moves a tab to another tab's position", () => {
		expect(moveTabBefore(tabs, 2, 0).map(t => t.key)).toEqual([2, 0, 1, 3]);
		expect(moveTabBefore(tabs, 0, 3).map(t => t.key)).toEqual([1, 2, 0, 3]);
	});

	test("keeps the order for identical or unknown keys", () => {
		expect(moveTabBefore(tabs, 1, 1).map(t => t.key)).toEqual([0, 1, 2, 3]);
		expect(moveTabBefore(tabs, 1, 99).map(t => t.key)).toEqual([0, 1, 2, 3]);
		expect(moveTabBefore(tabs, 99, 1).map(t => t.key)).toEqual([0, 1, 2, 3]);
	});
});
