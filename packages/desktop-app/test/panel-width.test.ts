import { describe, expect, it } from "bun:test";
import { MAX_PANEL_WIDTH, MIN_CHAT_WIDTH, MIN_PANEL_WIDTH, maxPanelWidth } from "../src/lib/panel-width";

/**
 * The chat column must keep a minimum width: a panel that grows past the window
 * budget squeezes messages into one word per line and gives the composer's
 * action row nowhere to go (user: 主视图被无限调节压扁).
 */
describe("maxPanelWidth", () => {
	it("caps the panel so the chat column keeps its minimum", () => {
		// Wide window: panel right edge 1520, chat column starts at 232.
		expect(maxPanelWidth(1520, 232)).toBe(1520 - 232 - MIN_CHAT_WIDTH);
	});

	it("keeps the absolute maximum on a very wide window", () => {
		expect(maxPanelWidth(2400, 200)).toBe(MAX_PANEL_WIDTH);
	});

	it("never drops below the minimum panel width on a cramped window", () => {
		expect(maxPanelWidth(600, 500)).toBe(MIN_PANEL_WIDTH);
	});

	it("falls back to the absolute maximum when the layout cannot be measured", () => {
		expect(maxPanelWidth(Number.NaN, 100)).toBe(MAX_PANEL_WIDTH);
	});
});
