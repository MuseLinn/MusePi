import { describe, expect, test } from "bun:test";
import {
	nextStrokeId,
	parseSketchScene,
	type SketchScene,
	type SketchStroke,
	sceneHasImage,
	sceneStrokesFor,
	serializeScene,
} from "../src/lib/sketch-scene";

/** A scene that exercises every stride the board stores: pen triplets (with
 *  pressure), a four-number shape box, a two-number text anchor. */
function sampleScene(): SketchScene {
	const strokes: SketchStroke[] = [
		{ id: 1, tool: "pen", color: "#1f2328", size: 4, points: [10, 20, 0.5, 30.44, 40.06, 0.3333] },
		{ id: 2, tool: "rect", color: "#e5484d", size: 2, points: [5.55, 6.44, 100.01, 200.99] },
		{ id: 3, tool: "text", color: "#3e63dd", size: 6, points: [12.34, 56.78, 180, 60], text: "hello" },
	];
	return serializeScene(strokes, 800, 600);
}

describe("serializeScene", () => {
	test("round-trips through parse with every tool and stride intact", () => {
		const scene = sampleScene();
		const back = parseSketchScene(JSON.parse(JSON.stringify(scene)));
		expect(back).toEqual(scene);
		expect(back?.strokes[0].points).toHaveLength(6);
		expect(back?.strokes[1].points).toHaveLength(4);
		expect(back?.strokes[2].points).toHaveLength(4);
		expect(back?.strokes[2].text).toBe("hello");
	});

	test("migrates a legacy two-number text anchor into a box", () => {
		// Text used to store [x, y] and measure its label at paint time. A
		// stored scene from then must restore as a box, not be thrown away.
		const legacy = {
			v: 1,
			w: 800,
			h: 600,
			strokes: [{ id: 7, tool: "text", color: "#000", size: 4, points: [20, 30], text: "hi" }],
		};
		const back = parseSketchScene(legacy);
		expect(back).not.toBeNull();
		expect(back?.strokes).toHaveLength(1);
		expect(back?.strokes[0].points).toHaveLength(4);
		expect(back?.strokes[0].points[0]).toBe(20);
		expect(back?.strokes[0].points[1]).toBe(30);
		expect(back?.strokes[0].points[2]).toBeGreaterThan(0);
		expect(back?.strokes[0].points[3]).toBeGreaterThan(0);
		expect(back?.strokes[0].text).toBe("hi");
	});

	test("stamps the format version and the board size", () => {
		const scene = serializeScene([], 1024, 768);
		expect(scene.v).toBe(1);
		expect(scene.w).toBe(1024);
		expect(scene.h).toBe(768);
	});

	test("quantizes coordinates to 0.1px and pressure to 2 decimals", () => {
		const scene = serializeScene(
			[{ id: 1, tool: "pen", color: "#000", size: 4, points: [10.123, 20.987, 0.4567] }],
			800,
			600,
		);
		expect(scene.strokes[0].points).toEqual([10.1, 21, 0.46]);
	});

	test("never serializes a non-finite coordinate (a NaN blanks the Konva node)", () => {
		const scene = serializeScene(
			[{ id: 1, tool: "rect", color: "#000", size: 2, points: [0, 0, Number.NaN, 10] }],
			800,
			600,
		);
		expect(scene.strokes[0].points).toEqual([0, 0, 0, 10]);
	});
});

describe("parseSketchScene", () => {
	test("rejects junk instead of throwing", () => {
		for (const bad of [null, undefined, 0, "scene", [], {}, { v: 2, w: 1, h: 1, strokes: [] }]) {
			expect(parseSketchScene(bad)).toBeNull();
		}
	});

	test("drops a single corrupt stroke but keeps the rest of the board", () => {
		const scene = sampleScene();
		const raw = JSON.parse(JSON.stringify(scene)) as Record<string, unknown>;
		(raw.strokes as unknown[]).splice(
			1,
			0,
			{ tool: "nope" },
			{ tool: "pen", color: "#000", size: 2, points: [1, 2] },
		);
		const back = parseSketchScene(raw);
		expect(back?.strokes).toHaveLength(3);
		expect(back?.strokes.map(s => s.id)).toEqual([1, 2, 3]);
	});

	test("rejects a truncated pen stroke (its last point lost its pressure)", () => {
		const raw = {
			v: 1,
			w: 100,
			h: 100,
			strokes: [{ id: 1, tool: "pen", color: "#000", size: 2, points: [1, 2, 0.5, 3, 4] }],
		};
		expect(parseSketchScene(raw)?.strokes).toHaveLength(0);
	});

	test("keeps an image stroke's src, since the board must decode it again", () => {
		const scene = serializeScene(
			[{ id: 9, tool: "image", color: "#000", size: 4, points: [0, 0, 100, 100], src: "data:image/png;base64,AA" }],
			800,
			600,
		);
		const back = parseSketchScene(JSON.parse(JSON.stringify(scene)));
		expect(back?.strokes[0].src).toBe("data:image/png;base64,AA");
	});
});

describe("sceneHasImage", () => {
	test("flags a board that holds an imported picture (too big to stash)", () => {
		expect(sceneHasImage(sampleScene())).toBe(false);
		const withImage = serializeScene(
			[{ id: 1, tool: "image", color: "#000", size: 4, points: [0, 0, 10, 10], src: "data:image/png;base64,AA" }],
			800,
			600,
		);
		expect(sceneHasImage(withImage)).toBe(true);
	});
});

describe("sceneStrokesFor", () => {
	test("returns the identical stroke list when the board size matches", () => {
		const scene = sampleScene();
		expect(sceneStrokesFor(scene, 800, 600)).toBe(scene.strokes);
	});

	test("ignores a sub-1% resize blink", () => {
		const scene = sampleScene();
		expect(sceneStrokesFor(scene, 802, 601)).toBe(scene.strokes);
	});

	test("rescales uniformly into a smaller board, pressure untouched", () => {
		const scene = sampleScene();
		const out = sceneStrokesFor(scene, 400, 300);
		// Half the board → half the geometry, same pressure, half the ink width.
		expect(out[0].points).toEqual([5, 10, 0.5, 15.2, 20.05, 0.33]);
		expect(out[0].size).toBe(2);
		expect(out[1].points).toEqual([2.8, 3.2, 50, 100.5]);
	});

	test("keeps proportions on a non-uniform board (uniform factor)", () => {
		const scene = sampleScene();
		// Half width but the same height → the min of the two ratios wins.
		const out = sceneStrokesFor(scene, 400, 600);
		expect(out[0].points[0]).toBeCloseTo(5, 6);
	});

	test("a degenerate stored size is a no-op, not a NaN stroke", () => {
		const scene: SketchScene = { v: 1, w: 0, h: 0, strokes: sampleScene().strokes };
		expect(sceneStrokesFor(scene, 800, 600)).toBe(scene.strokes);
	});
});

describe("nextStrokeId", () => {
	test("continues past the highest restored id so nodes never collide", () => {
		expect(nextStrokeId(sampleScene().strokes)).toBe(4);
		expect(nextStrokeId([])).toBe(1);
	});
});
