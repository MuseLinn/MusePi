import { describe, expect, it } from "bun:test";
import * as viewport from "../src/lib/browser-viewport";

const pageBox = { layoutWidth: 393, layoutHeight: 852, scale: 1 };

describe("blank-page viewport drag controls", () => {
	it("hides viewport controls without a page or a preset", () => {
		expect(viewport.viewportControlsVisible(false, pageBox, 393)).toBe(false);
		expect(viewport.viewportControlsVisible(true, null, 393)).toBe(false);
		expect(viewport.viewportControlsVisible(true, pageBox, null)).toBe(false);
		expect(viewport.viewportControlsVisible(true, pageBox, 393)).toBe(true);
	});

	it("starts a drag only for a page", () => {
		expect(viewport.beginViewportDrag(false, pageBox, "x", 100)).toBeNull();
		expect(viewport.beginViewportDrag(true, pageBox, "x", 100)).toEqual({
			axis: "x",
			startClient: 100,
			startSize: 393,
			scale: 1,
		});
	});

	it("cancels an existing drag when the page becomes blank", () => {
		const drag = viewport.beginViewportDrag(true, pageBox, "y", 200);
		expect(viewport.cancelViewportDragOnBlank(drag, false)).toBeNull();
		expect(viewport.cancelViewportDragOnBlank(drag, true)).toBe(drag);
	});
});
