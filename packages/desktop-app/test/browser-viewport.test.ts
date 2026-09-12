import { describe, expect, it } from "bun:test";
import { fitViewport } from "../src/lib/browser-viewport";

/**
 * Preset fitting contract: a phone/tablet/desktop preset must keep its LAYOUT
 * width (that is what makes the responsive check meaningful) and only ever be
 * scaled down to fit the panel — never up, and never by a height budget the
 * width-only presets do not declare.
 */
describe("fitViewport", () => {
	it("scales a desktop preset down to the available width", () => {
		expect(fitViewport(1440, 420).scale).toBeCloseTo(420 / 1440, 5);
	});

	it("keeps a narrow preset at 1:1 in a wide panel", () => {
		expect(fitViewport(393, 1200).scale).toBe(1);
	});

	it("keeps the preset width as the layout width", () => {
		expect(fitViewport(768, 420).width).toBe(768);
	});

	it("falls back to 1 when the available width is unknown", () => {
		expect(fitViewport(768, 0).scale).toBe(1);
	});
});
