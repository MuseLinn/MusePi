import { describe, expect, it } from "bun:test";
import {
	getPanelOccupancy,
	MAX_PANEL_WIDTH,
	MIN_CHAT_WIDTH,
	MIN_PANEL_WIDTH,
	maxPanelWidth,
	PANEL_CARD_GUTTER_PX,
	panelRowWidth,
	setPanelOccupancy,
	subscribePanelOccupancy,
} from "../src/lib/panel-width";

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

/**
 * The session info dock budgets beside the panel, so it needs the panel's row
 * footprint from the panel rather than from a rect it measures itself: a rect
 * read during a drag would make the seat follow every frame of the resize.
 */
describe("panelRowWidth", () => {
	it("spends nothing while folded, and the card plus both gutters when docked", () => {
		expect(panelRowWidth({ open: false, maximized: false, width: 480 })).toBe(0);
		expect(panelRowWidth({ open: true, maximized: false, width: 480 })).toBe(480 + PANEL_CARD_GUTTER_PX * 2);
	});

	it("spends nothing while maximized: the float covers the chat instead of sitting beside it", () => {
		expect(panelRowWidth({ open: true, maximized: true, width: 900 })).toBe(0);
	});

	it("ignores a negative or unmeasured width instead of subtracting from the row", () => {
		expect(panelRowWidth({ open: true, maximized: false, width: -20 })).toBe(PANEL_CARD_GUTTER_PX * 2);
	});
});

describe("panel occupancy store", () => {
	it("notifies subscribers once per real change and stops after unsubscribe", () => {
		let calls = 0;
		const unsubscribe = subscribePanelOccupancy(() => {
			calls += 1;
		});
		setPanelOccupancy({ open: true, maximized: false, width: 400 });
		expect(calls).toBe(1);
		// Same answer again: nothing changed, so nothing re-renders.
		setPanelOccupancy({ open: true, maximized: false, width: 400 });
		expect(calls).toBe(1);
		expect(getPanelOccupancy()).toEqual({ open: true, maximized: false, width: 400 });

		setPanelOccupancy({ open: false, maximized: false, width: 0 });
		expect(calls).toBe(2);
		unsubscribe();
		setPanelOccupancy({ open: true, maximized: false, width: 400 });
		expect(calls).toBe(2);
		setPanelOccupancy({ open: false, maximized: false, width: 0 });
	});
});
