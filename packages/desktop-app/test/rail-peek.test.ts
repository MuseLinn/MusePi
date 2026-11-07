import { describe, expect, test } from "bun:test";
import { railPeekEligible } from "../src/lib/rail-peek";

const base = {
	sideCollapsed: true,
	pageDestinationActive: false,
	settingsActive: false,
	narrowSidebarOpen: false,
};

describe("railPeekEligible", () => {
	test("closed docked panel on 首页 floats on hover", () => {
		expect(railPeekEligible(base)).toBe(true);
	});

	test("a docked (open) panel never floats a duplicate", () => {
		expect(railPeekEligible({ ...base, sideCollapsed: false })).toBe(false);
	});

	test("page destinations, settings and the narrow drawer are excluded", () => {
		expect(railPeekEligible({ ...base, pageDestinationActive: true })).toBe(false);
		expect(railPeekEligible({ ...base, settingsActive: true })).toBe(false);
		expect(railPeekEligible({ ...base, narrowSidebarOpen: true })).toBe(false);
	});
});
