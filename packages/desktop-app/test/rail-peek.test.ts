import { describe, expect, test } from "bun:test";
import { isSidebarPanelId, railPeekEligible, resolveSidebarPanel } from "../src/lib/rail-peek";

const base = {
	sideCollapsed: true,
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

	test("settings and the narrow drawer are excluded", () => {
		expect(railPeekEligible({ ...base, settingsActive: true })).toBe(false);
		expect(railPeekEligible({ ...base, narrowSidebarOpen: true })).toBe(false);
	});

	test("a page destination is NOT excluded — its rail button owns a panel too", () => {
		// Regression: 任务中心 used to be excluded, so its hover-peek could
		// never show and the rail floated the 首页 session list instead.
		expect(railPeekEligible(base)).toBe(true);
	});
});

describe("isSidebarPanelId", () => {
	test("only declared panel ids may float", () => {
		expect(isSidebarPanelId("home")).toBe(true);
		expect(isSidebarPanelId("scheduled")).toBe(true);
		expect(isSidebarPanelId("capability")).toBe(true);
		expect(isSidebarPanelId("board")).toBe(false);
		expect(isSidebarPanelId(null)).toBe(false);
	});
});

const docked = {
	settingsActive: false,
	sideCollapsed: false,
	peekPanel: null,
	scheduledActive: false,
	capabilityActive: false,
	pageDestinationActive: false,
};

describe("resolveSidebarPanel", () => {
	test("docked destinations show only the panel they own", () => {
		expect(resolveSidebarPanel(docked)).toBe("home");
		expect(resolveSidebarPanel({ ...docked, scheduledActive: true, pageDestinationActive: true })).toBe("scheduled");
		expect(resolveSidebarPanel({ ...docked, capabilityActive: true, pageDestinationActive: true })).toBe(
			"capability",
		);
		// Board / PR still own a single-column surface: no second-tier panel.
		expect(resolveSidebarPanel({ ...docked, pageDestinationActive: true })).toBeNull();
	});

	test("a folded panel stays hidden until a rail button reports its panel", () => {
		expect(resolveSidebarPanel({ ...docked, sideCollapsed: true })).toBeNull();
		expect(resolveSidebarPanel({ ...docked, sideCollapsed: true, peekPanel: "home" })).toBe("home");
		expect(resolveSidebarPanel({ ...docked, sideCollapsed: true, peekPanel: "scheduled" })).toBe("scheduled");
		expect(resolveSidebarPanel({ ...docked, sideCollapsed: true, peekPanel: "capability" })).toBe("capability");
		expect(resolveSidebarPanel({ ...docked, sideCollapsed: true, peekPanel: "board" })).toBeNull();
	});

	test("settings takes the slot back from every docked or floating panel", () => {
		expect(resolveSidebarPanel({ ...docked, settingsActive: true })).toBeNull();
		expect(
			resolveSidebarPanel({
				...docked,
				settingsActive: true,
				sideCollapsed: true,
				peekPanel: "scheduled",
				scheduledActive: true,
			}),
		).toBeNull();
	});
});
