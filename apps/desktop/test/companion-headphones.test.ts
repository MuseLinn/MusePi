import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPANION_ART_BOX_RATIO } from "../src/components/CompanionArt";
import { SplashOrb } from "../src/components/SplashOrb";
import { FACE_BOX, faceFor, toPath } from "../src/lib/companion-face";
import {
	cupAxis,
	cupCenter,
	cupIncludedAngleDeg,
	HEADPHONE_RIG,
	HEADPHONE_SCALE,
	headphoneBounds,
	headphoneClearance,
	headphoneFront,
	headphonePadding,
	joinLength,
} from "../src/lib/companion-headphones";

/**
 * The builtin cans are one coaxial stack per ear. These tests lock the
 * construction the front view is projected from: tilt, clearance, and the
 * short join. A changed number here changes the painted headset.
 */

describe("companion headphones", () => {
	test("the cans share an XZ axis at 60 degrees with no outward splay", () => {
		expect(HEADPHONE_RIG.cupTiltRad).toBeCloseTo(Math.PI / 3, 8);
		expect(HEADPHONE_RIG.cupDist).toBe(1.08);
		expect(HEADPHONE_RIG.cupZ).toBe(0.2);
		expect(HEADPHONE_RIG.cupHalf).toBe(0.14);
		expect(HEADPHONE_RIG.plateR).toBe(0.165);
		expect(HEADPHONE_RIG.cupR).toBe(0.21);
		expect(HEADPHONE_RIG.padR).toBe(0.222);
		expect(HEADPHONE_RIG.plateDomeH).toBe(0);
		expect(HEADPHONE_RIG.cheekR).toBe(0);
		expect(HEADPHONE_RIG.outerPadR).toBe(0);
		expect(HEADPHONE_SCALE).toBe(1.08);
		expect(cupAxis("R")[1]).toBe(0);
		expect(cupAxis("L")[1]).toBe(0);
		expect(cupIncludedAngleDeg()).toBeCloseTo(120, 5);
		const centre = cupCenter("R");
		expect(Math.hypot(centre[0], centre[1], centre[2])).toBeCloseTo(1.099, 2);
	});

	test("pad, wall, plate and the crown band stay outside the gold", () => {
		const clearance = headphoneClearance();
		expect(clearance.pad).toBeGreaterThanOrEqual(1.02);
		expect(clearance.shell).toBeGreaterThanOrEqual(1.02);
		expect(clearance.plate).toBeGreaterThanOrEqual(1.02);
		expect(clearance.band).toBeGreaterThanOrEqual(1.02);
		expect(clearance.lining).toBeGreaterThanOrEqual(1.02);
	});

	test("the front view shows the cylinder side and a short straight join", () => {
		const art = headphoneFront(FACE_BOX / 2);
		const plate = art.discs.find(disc => disc.side === "R" && disc.role === "plate");
		if (!plate) throw new Error("right plate missing");
		expect(plate.ry).toBeGreaterThan(plate.rx);
		expect(plate.rx / plate.ry).toBeCloseTo(Math.cos(Math.PI / 3), 5);
		expect(art.joins).toHaveLength(2);
		expect(joinLength("R")).toBeGreaterThan(0.04);
		expect(joinLength("R")).toBeLessThan(0.09);
		expect(joinLength("L")).toBeCloseTo(joinLength("R"), 5);
	});

	test("the stage padding contains the scaled cans", () => {
		const pad = headphonePadding(FACE_BOX);
		const bounds = headphoneBounds(FACE_BOX / 2);
		expect(bounds.minX).toBeGreaterThanOrEqual(-pad.side);
		expect(bounds.maxX).toBeLessThanOrEqual(FACE_BOX + pad.side);
		expect(bounds.minY).toBeGreaterThanOrEqual(-pad.top);
		expect(bounds.maxY).toBeLessThanOrEqual(FACE_BOX + pad.bottom);
		const ratio = (FACE_BOX + pad.side * 2) / (FACE_BOX + pad.top + pad.bottom);
		expect(COMPANION_ART_BOX_RATIO).toBeCloseTo(ratio, 6);
	});

	test("the launch splash draws this face and these cans", () => {
		const html = renderToStaticMarkup(createElement(SplashOrb));
		const happy = toPath(faceFor("happy")[0]);
		expect(html.includes(happy.slice(0, 24))).toBe(true);
		expect(html.includes("gui-splash-orb-wear")).toBe(true);
		expect(html.includes("gui-splash-orb-rose")).toBe(false);
		expect(html.includes("<ellipse")).toBe(true);
	});
});
