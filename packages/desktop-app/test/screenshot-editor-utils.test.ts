import { describe, expect, test } from "bun:test";
import { clampRegion, drawAnnotations, formatHex, formatRgba } from "../src/lib/screenshot-editor-utils";

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

	test("drawAnnotations translates annotations into cropped output coordinates", () => {
		const lines: number[][] = [];
		const labels: Array<{ text: string; x: number; y: number }> = [];
		const context = {
			save() {},
			restore() {},
			setLineDash() {},
			strokeRect() {},
			beginPath() {},
			moveTo(x: number, y: number) {
				lines.push([x, y]);
			},
			lineTo(x: number, y: number) {
				lines.push([x, y]);
			},
			stroke() {},
			fillText(text: string, x: number, y: number) {
				labels.push({ text, x, y });
			},
		} as unknown as CanvasRenderingContext2D;

		drawAnnotations(
			context,
			[
				{ type: "arrow", x0: 120, y0: 80, x1: 180, y1: 140 },
				{ type: "text", x: 150, y: 100, text: "here" },
			],
			{ scale: 1, offsetX: 100, offsetY: 50 },
		);

		expect(lines[0]).toEqual([20, 30]);
		expect(lines[1]).toEqual([80, 90]);
		expect(labels).toEqual([{ text: "here", x: 50, y: 50 }]);
	});
});
