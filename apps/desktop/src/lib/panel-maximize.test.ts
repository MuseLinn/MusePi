import { describe, expect, it } from "bun:test";
import { panelSeamX } from "./panel-maximize";

/**
 * The right panel's width grip sits in the middle of the gap between the scene
 * card and the panel. `null` is the contract that hides the band: a band left
 * at its previous seam is the reported "握把错位" after a scene swap.
 */
describe("panelSeamX", () => {
	it("sits in the middle of the card/panel gap", () => {
		expect(panelSeamX({ right: 1000 }, { left: 1016 }, 1600)).toBe(1008);
	});

	it("places nothing without a card", () => {
		expect(panelSeamX(null, { left: 1016 }, 1600)).toBeNull();
	});

	it("places nothing when the card is parked off-screen", () => {
		expect(panelSeamX({ right: 0 }, { left: 1016 }, 1600)).toBeNull();
		expect(panelSeamX({ right: 1600 }, { left: 0 }, 1600)).toBeNull();
	});

	it("keeps the seam when the panel covers the card (maximized)", () => {
		// Worst case for the old `cardRect.right >= panelRect.left` guard: a
		// left-parked scene card under a maximized panel still has a seam.
		expect(panelSeamX({ right: 1200 }, { left: 280 }, 1600)).toBe(740);
	});
});
