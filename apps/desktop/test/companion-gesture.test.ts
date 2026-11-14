import { describe, expect, test } from "bun:test";
import {
	advanceCompanionGesture,
	type CompanionGestureInput,
	companionGestureTransform,
	createCompanionGestureMotion,
} from "../src/lib/companion-gesture";

const input = (patch: Partial<CompanionGestureInput> = {}): CompanionGestureInput => ({
	pressed: true,
	dragging: true,
	vx: 0,
	vy: 0,
	at: 0,
	releasedAt: null,
	...patch,
});

describe("builtin orb gesture motion", () => {
	test("travel direction becomes continuous signed tilt, never a mirror", () => {
		const state = createCompanionGestureMotion();
		advanceCompanionGesture(state, input({ vx: 900 }), 64, 64);
		const right = state.tilt;
		advanceCompanionGesture(state, input({ vx: -900 }), 64, 128);
		expect(right).toBeGreaterThan(0);
		expect(state.tilt).toBeGreaterThan(0);
		expect(state.tilt).toBeLessThan(right);
		expect(companionGestureTransform(state, 228)).not.toContain("scale(-1");
	});

	test("a stopped pointer releases velocity without changing the held pose instantly", () => {
		const state = createCompanionGestureMotion();
		advanceCompanionGesture(state, input({ vx: 900 }), 64, 64);
		const moving = state.tilt;
		advanceCompanionGesture(state, input({ vx: 900 }), 64, 200);
		expect(state.tilt).toBeLessThan(moving);
		expect(state.tilt).toBeGreaterThan(0);
	});

	test("dragging stretches and lifts while preserving the session transform", () => {
		const state = createCompanionGestureMotion();
		advanceCompanionGesture(state, input({ vy: 1400 }), 64, 64);
		const transform = companionGestureTransform(state, 228);
		expect(state.stretch).toBeGreaterThan(0);
		expect(state.lift).toBeLessThan(0);
		expect(transform).toContain("translate(0 -");
		expect(transform).toContain("scale(");
	});

	test("release returns lift and tilt to rest with a bounded landing rebound", () => {
		const state = createCompanionGestureMotion();
		for (let now = 64; now <= 640; now += 64) advanceCompanionGesture(state, input({ vx: 900, vy: 800 }), 64, now);
		const released = input({ pressed: false, dragging: false, vx: 0, vy: 0, releasedAt: 700 });
		advanceCompanionGesture(state, released, 64, 700);
		expect(state.drop).toBe(0);
		advanceCompanionGesture(state, released, 64, 780);
		expect(state.drop).toBeGreaterThan(0);
		for (let now = 844; now <= 1800; now += 64) advanceCompanionGesture(state, released, 64, now);
		expect(Math.abs(state.tilt)).toBeLessThan(0.01);
		expect(Math.abs(state.lift)).toBeLessThan(0.01);
		expect(state.drop).toBe(0);
		expect(state.squash).toBe(0);
	});

	test("invalid and large frame deltas cannot produce non-finite geometry", () => {
		const state = createCompanionGestureMotion();
		advanceCompanionGesture(state, input({ vx: Infinity, vy: Number.NaN }), 10_000, 64);
		for (const value of Object.values(state)) expect(Number.isFinite(value)).toBe(true);
		expect(Math.abs(state.tilt)).toBeLessThanOrEqual(11);
	});
});
