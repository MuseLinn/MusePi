import { describe, expect, it } from "bun:test";
import { clampViewportSize, resolveViewportScale, viewportClip, viewportOverflow } from "./browser-viewport";

describe("managed browser viewport controls", () => {
	it("keeps fit responsive while honoring manual display scale independently", () => {
		expect(resolveViewportScale(0.4, "fit")).toBe(0.4);
		expect(resolveViewportScale(0.4, 1)).toBe(1);
		expect(resolveViewportScale(0.4, 0.4)).toBe(0.4);
		expect(resolveViewportScale(0.4, 99)).toBe(2);
	});

	it("clamps numeric viewport dimensions to the supported device range", () => {
		expect(clampViewportSize(100, 100)).toEqual({ width: 320, height: 480 });
		expect(clampViewportSize(9999, 9999)).toEqual({ width: 7680, height: 4320 });
		expect(clampViewportSize(1440, 900)).toEqual({ width: 1440, height: 900 });
	});

	it("reports overflow so enlarged pages scroll instead of being clipped", () => {
		expect(viewportOverflow(1440, 900, 1, 500, 500)).toEqual({ x: true, y: true });
		expect(viewportOverflow(1440, 900, 0.4, 600, 500)).toEqual({ x: false, y: false });
	});

	it("clips the transformed host to the real scrollport in local coordinates", () => {
		expect(
			viewportClip(
				{ x: 500, y: 100, width: 1440, height: 900, scale: 2 },
				{ x: 600, y: 150, width: 400, height: 300 },
			),
		).toEqual({ top: 25, right: 1190, bottom: 725, left: 50 });
	});
});
