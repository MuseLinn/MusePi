import { describe, expect, it } from "bun:test";
import { MIN_CHAT_WIDTH, MIN_PANEL_WIDTH } from "../src/lib/panel-width";
import { sidebarDrawerThreshold } from "../src/lib/sidebar-drawer";

/** Rails + gutters the helper reserves around the column (52 + 44 + 24). */
const FRAME = 120;

describe("sidebarDrawerThreshold", () => {
	it("reserves the session minimum when no panel is docked", () => {
		expect(sidebarDrawerThreshold(256, false)).toBe(FRAME + 256 + MIN_CHAT_WIDTH);
	});

	it("adds the docked panel's minimum when the panel is open", () => {
		expect(sidebarDrawerThreshold(256, true)).toBe(FRAME + 256 + MIN_CHAT_WIDTH + MIN_PANEL_WIDTH);
	});

	it("tracks a dragged sidebar width", () => {
		expect(sidebarDrawerThreshold(420, false) - sidebarDrawerThreshold(180, false)).toBe(240);
	});
});
