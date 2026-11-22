import { describe, expect, test } from "bun:test";
import { type EyeShape, FACE_CENTRE, faceFor, lerpFace, mouthSpecFor, RING_POINTS } from "../src/lib/companion-face";

/**
 * The builtin face is twelve closed rings that morph into each other.
 * A ring that is short, wound the wrong way, or opened at the side lerps
 * into a scribble instead of an expression.
 */

const SHAPES: readonly EyeShape[] = [
	"open",
	"closed",
	"happy",
	"half",
	"wide",
	"squint",
	"tense",
	"sad",
	"bored",
	"dizzy",
	"cross",
	"star",
];

function ringArea(ring: ReadonlyArray<readonly [number, number]>): number {
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x1, y1] = ring[i];
		const [x2, y2] = ring[(i + 1) % ring.length];
		area += x1 * y2 - x2 * y1;
	}
	return area / 2;
}

function ringCentre(ring: ReadonlyArray<readonly [number, number]>): [number, number] {
	let x = 0;
	let y = 0;
	for (const p of ring) {
		x += p[0];
		y += p[1];
	}
	return [x / ring.length, y / ring.length];
}

describe("companion face rings", () => {
	test("every shape is a 48-point clockwise ring that starts at the top", () => {
		for (const shape of SHAPES) {
			const [left, right] = faceFor(shape);
			for (const ring of [left, right]) {
				expect(ring).toHaveLength(RING_POINTS);
				expect(new Set(ring.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`)).size).toBe(RING_POINTS);
				// y-down shoelace is positive when the loop is clockwise on screen.
				expect(ringArea(ring)).toBeGreaterThan(0);
				const [cx, cy] = ringCentre(ring);
				const angle = (Math.atan2(ring[0][1] - cy, ring[0][0] - cx) * 180) / Math.PI;
				if (shape === "happy") {
					// A crescent's centroid sits in the stroke, so the zenith ray
					// is not the upper rim. Point 0 is still on that rim.
					const top = Math.min(...ring.map(p => p[1]));
					expect(ring[0][1] - top).toBeLessThan(2);
				} else {
					expect(Math.abs(angle + 90)).toBeLessThan(8);
				}
			}
			expect(mouthSpecFor(shape)).toHaveLength(4);
		}
	});

	test("happy is a symmetric crescent and half lowers the lid", () => {
		const [left, right] = faceFor("happy");
		const dx = right[0][0] - left[0][0];
		expect(Math.abs(dx)).toBeGreaterThan(20);
		for (let i = 0; i < left.length; i++) {
			expect(right[i][0] - left[i][0]).toBeCloseTo(dx, 1);
			expect(right[i][1]).toBeCloseTo(left[i][1], 1);
		}
		const openTop = Math.min(...faceFor("open")[0].map(p => p[1]));
		const halfTop = Math.min(...faceFor("half")[0].map(p => p[1]));
		expect(halfTop).toBeGreaterThan(openTop + 8);
	});

	test("two shapes lerp point for point without leaving face space", () => {
		const mid = lerpFace(faceFor("open"), faceFor("closed"), 0.5);
		expect(mid[0]).toHaveLength(RING_POINTS);
		expect(mid[1]).toHaveLength(RING_POINTS);
		const [cx, cy] = ringCentre(mid[0]);
		expect(Math.abs(cx - FACE_CENTRE[0])).toBeLessThan(80);
		expect(Number.isFinite(cy)).toBe(true);
		expect(mid[0].every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
	});
});
