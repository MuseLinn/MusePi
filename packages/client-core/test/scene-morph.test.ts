import { describe, expect, it } from "bun:test";
import type { MorphRect } from "../src/components/image-morph";
import { heightMorphMs, sceneKeyframes, sessionTitleMorphId } from "../src/lib/scene-morph";

/**
 * Contract (M1.10 §3.3/§3.2 批次 B): the guest scene morph is driven by two
 * pure functions. `sceneKeyframes` must land the incoming shared element
 * exactly on the outgoing rect (a wrong first frame teleports the flying
 * element; a wrong last frame leaves it offset) and return null for
 * degenerate sources so the caller skips the flight instead of flying from
 * a zero-sized box. `heightMorphMs` implements the §3.2 高度形变 ladder
 * (delta/6, clamped 240-480) — a wrong duration breaks the shared motion
 * ladder with the desktop HeightMorph standard.
 */
const rect = (left: number, top: number, width: number, height: number): MorphRect => ({
	left,
	top,
	width,
	height,
});

describe("sceneKeyframes", () => {
	it("identical rects → all five stops are the identity transform", () => {
		const frames = sceneKeyframes(rect(10, 20, 300, 200), rect(10, 20, 300, 200))!;
		expect(frames).toHaveLength(5);
		for (const f of frames) expect(f).toBe("translate(0px, 0px) scale(1, 1)");
	});

	it("first stop maps the target box exactly onto the source rect", () => {
		const frames = sceneKeyframes(rect(100, 50, 200, 100), rect(40, 80, 400, 200))!;
		expect(frames[0]).toBe("translate(60px, -30px) scale(0.5, 0.5)");
	});

	it("final stop is the identity — the element lands on its own layout", () => {
		const frames = sceneKeyframes(rect(0, 0, 100, 400), rect(0, 0, 200, 200))!;
		expect(frames[frames.length - 1]).toBe("translate(0px, 0px) scale(1, 1)");
	});

	it("mid stops interpolate monotonically toward identity (no reversal)", () => {
		const frames = sceneKeyframes(rect(0, 0, 100, 100), rect(40, 0, 400, 100))!;
		const x = frames.map(f => Number(/translate\((-?[\d.]+)px/.exec(f)![1]));
		for (let i = 1; i < x.length; i++) {
			expect(Math.abs(x[i])).toBeLessThan(Math.abs(x[i - 1]));
		}
	});

	it("degenerate source/target → null (caller skips the flight)", () => {
		const ok = rect(0, 0, 10, 10);
		expect(sceneKeyframes(rect(0, 0, 0, 10), ok)).toBeNull();
		expect(sceneKeyframes(rect(0, 0, 10, Number.NaN), ok)).toBeNull();
		expect(sceneKeyframes(ok, rect(0, 0, -5, 10))).toBeNull();
	});
});

describe("heightMorphMs", () => {
	it("small deltas clamp to the 240ms ladder floor", () => {
		expect(heightMorphMs(0)).toBe(240);
		expect(heightMorphMs(-40)).toBe(240);
		expect(heightMorphMs(600)).toBe(240); // 600/6 = 100 < 240
	});

	it("mid deltas follow delta/6", () => {
		expect(heightMorphMs(1800)).toBe(300);
		expect(heightMorphMs(2400)).toBe(400);
	});

	it("large deltas clamp to the 480ms ladder ceiling", () => {
		expect(heightMorphMs(4800)).toBe(480); // 4800/6 = 800 → capped
		expect(heightMorphMs(2880)).toBe(480); // exactly 4800... 2880/6 = 480
	});

	it("non-finite delta is degenerate input → 240ms floor, never NaN", () => {
		expect(heightMorphMs(Number.NaN)).toBe(240);
		expect(heightMorphMs(Number.POSITIVE_INFINITY)).toBe(240);
	});
});

describe("sessionTitleMorphId", () => {
	it("is stable per session id — both ends of the 列表↔会话 morph key on it", () => {
		expect(sessionTitleMorphId("abc")).toBe("session-title-abc");
		expect(sessionTitleMorphId("abc")).toBe(sessionTitleMorphId("abc"));
		expect(sessionTitleMorphId("abc")).not.toBe(sessionTitleMorphId("abd"));
	});
});
