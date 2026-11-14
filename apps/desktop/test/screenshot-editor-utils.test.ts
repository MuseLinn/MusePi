import { describe, expect, test } from "bun:test";
import {
	clampRegion,
	drawShotStrokes,
	formatHex,
	formatRgba,
	hitStroke,
	isUsableRegion,
	normalizeRegion,
	regionSize,
	type ShotStroke,
	strokeRegion,
} from "../src/lib/screenshot-editor-utils";

function recorder(): {
	ctx: CanvasRenderingContext2D;
	moves: number[][];
	labels: Array<{ text: string; x: number; y: number }>;
} {
	const moves: number[][] = [];
	const labels: Array<{ text: string; x: number; y: number }> = [];
	const ctx = {
		save() {},
		restore() {},
		beginPath() {},
		closePath() {},
		stroke() {},
		fill() {},
		ellipse() {},
		strokeRect() {},
		quadraticCurveTo() {},
		moveTo(x: number, y: number) {
			moves.push([x, y]);
		},
		lineTo(x: number, y: number) {
			moves.push([x, y]);
		},
		fillText(text: string, x: number, y: number) {
			labels.push({ text, x, y });
		},
		drawImage() {},
	} as unknown as CanvasRenderingContext2D;
	return { ctx, moves, labels };
}

const arrow: ShotStroke = { id: 1, tool: "arrow", color: "#e5484d", size: 2, points: [120, 80, 180, 140] };

describe("screenshot editor utils", () => {
	test("formatHex uses two uppercase hex digits per channel", () => {
		expect(formatHex({ r: 255, g: 0, b: 128, a: 255 })).toBe("#FF0080");
		expect(formatHex({ r: 0, g: 0, b: 0, a: 255 })).toBe("#000000");
	});

	test("formatRgba includes a normalized alpha", () => {
		expect(formatRgba({ r: 255, g: 0, b: 128, a: 255 })).toBe("rgba(255, 0, 128, 1)");
		expect(formatRgba({ r: 255, g: 0, b: 128, a: 128 })).toBe("rgba(255, 0, 128, 0.5)");
	});

	test("clampRegion clamps to image bounds and normalizes order", () => {
		expect(clampRegion({ x0: 200, y0: 120, x1: -10, y1: -5 }, 100, 100)).toEqual({
			x0: 0,
			y0: 0,
			x1: 100,
			y1: 100,
		});
	});

	test("normalizeRegion accepts a drag in any direction", () => {
		expect(normalizeRegion({ x: 40, y: 30 }, { x: 10, y: 5 })).toEqual({ x0: 10, y0: 5, x1: 40, y1: 30 });
	});

	test("a frame smaller than the minimum is a click, not a crop", () => {
		expect(isUsableRegion({ x0: 0, y0: 0, x1: 4, y1: 40 })).toBe(false);
		expect(isUsableRegion({ x0: 0, y0: 0, x1: 40, y1: 40 })).toBe(true);
		expect(regionSize({ x0: 10, y0: 20, x1: 40, y1: 60 })).toEqual({ width: 30, height: 40 });
	});

	test("drawShotStrokes translates annotations into cropped output coordinates", () => {
		const { ctx, moves, labels } = recorder();
		drawShotStrokes(
			ctx,
			[arrow, { id: 2, tool: "text", color: "#ffffff", size: 14, points: [150, 100, 60, 20], text: "here" }],
			{ scale: 1, offsetX: 100, offsetY: 50 },
		);

		expect(moves[0]).toEqual([20, 30]);
		expect(moves[1]).toEqual([80, 90]);
		expect(labels).toEqual([{ text: "here", x: 50, y: 50 }]);
	});

	test("the preview and the export share one transform", () => {
		const preview = recorder();
		const exported = recorder();
		drawShotStrokes(preview.ctx, [arrow], { scale: 0.5 });
		drawShotStrokes(exported.ctx, [arrow], { scale: 1, offsetX: 0, offsetY: 0 });
		expect(preview.moves[0]).toEqual([60, 40]);
		expect(preview.moves[1]).toEqual([90, 70]);
		expect(exported.moves.slice(0, 2)).toEqual([
			[120, 80],
			[180, 140],
		]);
	});

	test("strokeRegion gives text its box, not its width as a corner", () => {
		const box = strokeRegion({ id: 3, tool: "text", color: "#fff", size: 14, points: [10, 20, 60, 30], text: "x" });
		expect(box.x0).toBe(8);
		expect(box.y0).toBe(18);
		expect(box.x1).toBe(72);
		expect(box.y1).toBe(52);
	});

	test("mosaic paints the pixel patch into the cropped rect", () => {
		const draws: unknown[][] = [];
		const ctx = {
			save() {},
			restore() {},
			drawImage(...args: unknown[]) {
				draws.push(args);
			},
		} as unknown as CanvasRenderingContext2D;
		const patch = {} as CanvasImageSource;
		drawShotStrokes(ctx, [{ id: 5, tool: "mosaic", color: "#fff", size: 1, points: [100, 50, 260, 130] }], {
			scale: 1,
			offsetX: 80,
			offsetY: 20,
			mosaic: () => patch,
		});
		expect(draws).toEqual([[patch, 20, 30, 160, 80]]);
	});

	test("hitStroke reaches thin ink at any preview scale", () => {
		expect(hitStroke(arrow, { x: 150, y: 110 }, 2)).toBe(true);
		expect(hitStroke(arrow, { x: 150, y: 160 }, 2)).toBe(false);
		const rect: ShotStroke = { id: 4, tool: "rect", color: "#fff", size: 2, points: [10, 10, 90, 70] };
		expect(hitStroke(rect, { x: 50, y: 12 }, 2)).toBe(true);
		expect(hitStroke(rect, { x: 50, y: 40 }, 2)).toBe(false);
	});
});
