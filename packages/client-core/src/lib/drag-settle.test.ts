import { describe, expect, test } from "bun:test";
import { isFlick, settleMs, velocityFrom } from "./drag-settle";

/**
 * Release physics (comma DESIGN §6.1): velocity decides the outcome before
 * position does, and decides how long the settle takes.
 */

describe("velocityFrom", () => {
	test("no previous sample means no velocity", () => {
		expect(velocityFrom(null, { pos: 100, t: 10 })).toBe(0);
	});

	test("downward drag over time is positive", () => {
		expect(velocityFrom({ pos: 0, t: 0 }, { pos: 60, t: 100 })).toBeCloseTo(0.6, 5);
	});

	test("a zero-length interval is not a divide-by-zero", () => {
		expect(velocityFrom({ pos: 0, t: 5 }, { pos: 40, t: 5 })).toBe(0);
	});

	test("upward wiggle keeps its sign", () => {
		expect(velocityFrom({ pos: 80, t: 0 }, { pos: 20, t: 100 })).toBeLessThan(0);
	});
});

describe("settleMs", () => {
	test("a still release snaps deliberately", () => {
		expect(settleMs(40, 0)).toBe(260);
	});

	test("a fast release finishes fast", () => {
		expect(settleMs(140, 2)).toBeLessThan(140);
	});

	test("duration never falls below the readable floor", () => {
		expect(settleMs(1, 100)).toBe(90);
	});

	test("duration never exceeds the deliberate ceiling", () => {
		expect(settleMs(400, 0.06)).toBe(240);
	});
});

describe("isFlick", () => {
	test("downward flick in the dismiss direction", () => {
		expect(isFlick(0.8, 1)).toBe(true);
		expect(isFlick(-0.8, 1)).toBe(false);
	});

	test("leftward flick reveals, rightward flick closes", () => {
		expect(isFlick(-0.9, -1)).toBe(true);
		expect(isFlick(0.9, 1)).toBe(true);
	});

	test("a slow release is not a flick in either direction", () => {
		expect(isFlick(0.1, 1)).toBe(false);
		expect(isFlick(-0.1, -1)).toBe(false);
	});
});
