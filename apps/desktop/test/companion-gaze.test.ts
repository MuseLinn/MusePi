import { describe, expect, test } from "bun:test";
import {
	advanceGazeMotion,
	createGazeMotionState,
	GAZE_IDLE_MS,
	nextBlinkDelay,
	resolveGazeTarget,
} from "../src/lib/companion-gaze";

describe("pet gaze — pointer sampling", () => {
	test("the centre dead zone removes jitter without reducing full deflection", () => {
		expect(resolveGazeTarget({ x: 0.04, y: 0, at: 100 }, 200)).toEqual({ x: 0, y: 0 });
		expect(resolveGazeTarget({ x: 2, y: 0, at: 100 }, 200)?.x).toBe(1);
	});

	test("a stationary sample becomes a centre target instead of resuming idle drift", () => {
		expect(resolveGazeTarget({ x: 1, y: 0.5, at: 100 }, 100 + GAZE_IDLE_MS)).toEqual({ x: 0, y: 0 });
		expect(resolveGazeTarget(null, 100 + GAZE_IDLE_MS)).toBeNull();
	});

	test("legacy samples without timestamps keep their existing non-expiring contract", () => {
		expect(resolveGazeTarget({ x: 0.5, y: 0 }, 100 + GAZE_IDLE_MS)?.x).toBeCloseTo(0.468, 3);
	});
});

describe("pet gaze — layered motion", () => {
	test("the head follows more slowly than the eyes", () => {
		const state = createGazeMotionState();
		advanceGazeMotion(state, { x: 1, y: 0, at: 0 }, 120, 120);
		expect(state.eyeX).toBeGreaterThan(state.headX);
		expect(state.headX).toBeGreaterThan(0);
		expect(state.attention).toBeGreaterThan(0);
	});

	test("recentering is smooth rather than a snap", () => {
		const state = { eyeX: 1, eyeY: 0, headX: 1, headY: 0, attention: 1 };
		advanceGazeMotion(state, { x: 1, y: 0, at: 0 }, 600, GAZE_IDLE_MS);
		expect(state.headX).toBeGreaterThan(0);
		expect(state.headX).toBeLessThan(0.1);
		expect(state.eyeX).toBeLessThan(0.01);
		expect(state.attention).toBe(1);
	});

	test("removing the gaze source releases attention back to authored drift", () => {
		const state = { eyeX: 1, eyeY: 0, headX: 1, headY: 0, attention: 1 };
		advanceGazeMotion(state, null, 380, 1000);
		expect(state.attention).toBe(0);
	});
});

describe("pet blink cadence", () => {
	test("the same state cadence produces bounded, non-mechanical intervals", () => {
		expect(nextBlinkDelay(4000, 0)).toBe(2880);
		expect(nextBlinkDelay(4000, 1)).toBe(5120);
		expect(nextBlinkDelay(4000, 0.5)).not.toBe(nextBlinkDelay(4000, 0));
	});

	test("disabled blinking stays disabled", () => {
		expect(nextBlinkDelay(0, 0.5)).toBe(0);
	});
});
