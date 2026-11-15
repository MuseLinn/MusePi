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

describe("injected mark layer", () => {
	const { AGENT_MARK_SCRIPT, agentMarkCall } = require("../electron/agent-marks.cjs");

	it("encodes one JSON-safe call with rounded coordinates", () => {
		expect(agentMarkCall({ x: 12.6, y: 40.2, kind: "click" })).toBe(
			'window.__musepiAgentMarks && window.__musepiAgentMarks({"x":13,"y":40,"kind":"click"});',
		);
	});

	it("keeps the script free of a closing script tag and defines the guard", () => {
		expect(AGENT_MARK_SCRIPT).toContain("__musepiAgentMarks");
		expect(AGENT_MARK_SCRIPT).not.toContain("</script");
	});

	it("pulses one ring per call and stays installed once", async () => {
		const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
		if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
		try {
			new Function(AGENT_MARK_SCRIPT)();
			const layer = document.getElementById("musepi-agent-marks");
			expect(layer).not.toBeNull();
			window.__musepiAgentMarks({ x: 10, y: 20, kind: "click" });
			expect(layer.children.length).toBe(1);
			new Function(AGENT_MARK_SCRIPT)();
			expect(document.querySelectorAll("#musepi-agent-marks").length).toBe(1);
		} finally {
			await GlobalRegistrator.unregister();
		}
	});
});

describe("agent drag traces", () => {
	const { AGENT_MARK_SCRIPT, agentDragStep, agentPathCall } = require("../electron/agent-marks.cjs");

	it("classifies press, held move and release", () => {
		expect(agentDragStep("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2 })).toEqual({
			phase: "start",
			x: 1,
			y: 2,
		});
		expect(agentDragStep("Input.dispatchMouseEvent", { type: "mouseMoved", buttons: 1, x: 3, y: 4 })).toEqual({
			phase: "move",
			x: 3,
			y: 4,
		});
		expect(agentDragStep("Input.dispatchMouseEvent", { type: "mouseMoved", buttons: 0, x: 3, y: 4 })).toBeNull();
		expect(agentDragStep("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 6 })).toEqual({
			phase: "end",
			x: 5,
			y: 6,
		});
		expect(agentDragStep("Input.dispatchKeyEvent", { type: "keyDown" })).toBeNull();
	});

	it("encodes rounded points and paints a polyline once installed", async () => {
		expect(agentPathCall([{ x: 10.4, y: 20.6 }, { x: 30, y: 40 }])).toBe(
			"window.__musepiAgentPaths && window.__musepiAgentPaths([[10,21],[30,40]]);",
		);
		const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
		if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
		try {
			new Function(AGENT_MARK_SCRIPT)();
			window.__musepiAgentPaths([[10, 10], [60, 50]]);
			const svg = document.querySelector("#musepi-agent-marks svg");
			expect(svg).not.toBeNull();
			expect(svg.querySelector("polyline").getAttribute("points")).toBe("10,10 60,50");
		} finally {
			await GlobalRegistrator.unregister();
		}
	});
});
