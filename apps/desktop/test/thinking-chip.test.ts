import { describe, expect, it } from "bun:test";
import { clampThinkingChipLevel } from "../src/lib/thinking-chip";

describe("clampThinkingChipLevel", () => {
	it("keeps the level while the ladder is unknown (the first render before session.thinkingInfo)", () => {
		// Regression: reading `.length` here crashed ChatView with
		// "Cannot read properties of null (reading 'length')".
		expect(clampThinkingChipLevel("medium", null)).toBe("medium");
		expect(clampThinkingChipLevel("high", undefined)).toBe("high");
	});

	it("falls back to the model's first rung when the level is not offered", () => {
		expect(clampThinkingChipLevel("medium", ["low", "high", "max"])).toBe("low");
		expect(clampThinkingChipLevel("xhigh", ["minimal", "low"])).toBe("minimal");
	});

	it("prefers the session's canonical level over the first rung", () => {
		expect(clampThinkingChipLevel("medium", ["low", "high", "max"], "high")).toBe("high");
	});

	it("keeps a level the model offers, and keeps auto for thinking models", () => {
		expect(clampThinkingChipLevel("high", ["low", "high", "max"])).toBe("high");
		expect(clampThinkingChipLevel("auto", ["low", "high", "max"])).toBe("auto");
	});

	it("drops auto and any rung when the model has no controllable thinking", () => {
		expect(clampThinkingChipLevel("auto", [])).toBeNull();
		expect(clampThinkingChipLevel("medium", [])).toBeNull();
	});

	it("off stays off unless the session reports a canonical level", () => {
		expect(clampThinkingChipLevel(null, ["low", "high"])).toBeNull();
		expect(clampThinkingChipLevel(null, ["low", "high"], "low")).toBe("low");
	});
});
