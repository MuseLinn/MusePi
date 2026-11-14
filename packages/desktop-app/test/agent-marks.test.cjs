const { describe, expect, it } = require("bun:test");
const { agentMarkFor } = require("../electron/agent-marks.cjs");

describe("agent operation marks", () => {
	it("marks a click at the point the agent pressed", () => {
		expect(agentMarkFor("Input.dispatchMouseEvent", { type: "mousePressed", x: 120, y: 240 })).toEqual({
			x: 120,
			y: 240,
			kind: "click",
		});
	});

	it("marks a wheel event as a scroll at its point", () => {
		expect(
			agentMarkFor("Input.dispatchMouseEvent", { type: "mouseWheel", x: 40, y: 60, deltaY: 320 }),
		).toEqual({ x: 40, y: 60, kind: "scroll" });
	});

	it("leaves moves, releases and non-input commands unmarked", () => {
		for (const [method, params] of [
			["Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 }],
			["Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 2 }],
			["Input.dispatchKeyEvent", { type: "keyDown" }],
			["Page.navigate", { url: "https://example.com" }],
		]) {
			expect(agentMarkFor(method, params)).toBeNull();
		}
	});

	it("rejects non-finite coordinates instead of drawing off-screen", () => {
		expect(agentMarkFor("Input.dispatchMouseEvent", { type: "mousePressed", x: Number.NaN, y: 1 })).toBeNull();
		expect(agentMarkFor("Input.dispatchMouseEvent", { type: "mousePressed", x: 1 })).toBeNull();
	});
});
