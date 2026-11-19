import { describe, expect, test } from "bun:test";
import { pointInside, trayMenuPosition } from "../electron/tray-position.cjs";

const WIDTH = 316;
const HEIGHT = 440;

const winTaskbar = {
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

const taskbarTop = {
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	workArea: { x: 0, y: 40, width: 1920, height: 1040 },
};

const macMenuBar = {
	bounds: { x: 0, y: 0, width: 1512, height: 982 },
	workArea: { x: 0, y: 24, width: 1512, height: 958 },
};

describe("trayMenuPosition", () => {
	test("centres the menu on a bottom taskbar icon and opens above it", () => {
		const pos = trayMenuPosition({
			width: WIDTH,
			height: HEIGHT,
			trayBounds: { x: 1880, y: 1040, width: 24, height: 24 },
			point: { x: 1892, y: 1052 },
			display: winTaskbar,
			platform: "win32",
		});
		// Centre would be 1892 - 158 = 1734; the work-area gutter clamps it,
		// and the bottom clamp keeps the menu above the taskbar.
		expect(pos).toEqual({ x: 1600, y: 596 });
	});

	test("follows the icon instead of the screen edge", () => {
		const pos = trayMenuPosition({
			width: WIDTH,
			height: HEIGHT,
			trayBounds: { x: 1500, y: 1040, width: 24, height: 24 },
			point: { x: 1512, y: 1052 },
			display: winTaskbar,
			platform: "win32",
		});
		expect(pos).toEqual({ x: 1354, y: 596 });
	});

	test("flips below the icon when the taskbar sits at the top", () => {
		const pos = trayMenuPosition({
			width: WIDTH,
			height: HEIGHT,
			trayBounds: { x: 1880, y: 8, width: 24, height: 24 },
			point: { x: 1892, y: 20 },
			display: taskbarTop,
			platform: "win32",
		});
		expect(pos).toEqual({ x: 1600, y: 44 });
	});

	test("drops the menu below the macOS menu bar icon", () => {
		const pos = trayMenuPosition({
			width: WIDTH,
			height: HEIGHT,
			trayBounds: { x: 1400, y: 6, width: 24, height: 24 },
			point: { x: 1412, y: 18 },
			display: macMenuBar,
			platform: "darwin",
		});
		// Centre would be 1412 - 158 = 1254; the right-edge gutter clamps it.
		expect(pos).toEqual({ x: 1192, y: 34 });
	});

	test("falls back to the pointer when the tray has no rectangle", () => {
		const pos = trayMenuPosition({
			width: WIDTH,
			height: HEIGHT,
			trayBounds: null,
			point: { x: 700, y: 10 },
			display: macMenuBar,
			platform: "darwin",
		});
		expect(pos).toEqual({ x: 542, y: 28 });
	});

	test("ignores a tray rectangle that belongs to another display", () => {
		const pos = trayMenuPosition({
			width: WIDTH,
			height: HEIGHT,
			trayBounds: { x: -1500, y: 1050, width: 24, height: 24 },
			point: { x: 500, y: 1050 },
			display: winTaskbar,
			platform: "win32",
		});
		expect(pos).toEqual({ x: 342, y: 596 });
	});

	test("keeps the menu inside a small work area", () => {
		const pos = trayMenuPosition({
			width: WIDTH,
			height: HEIGHT,
			trayBounds: null,
			point: { x: 100, y: 300 },
			display: {
				bounds: { x: 0, y: 0, width: 400, height: 300 },
				workArea: { x: 0, y: 0, width: 400, height: 300 },
			},
			platform: "win32",
		});
		expect(pos.x).toBe(4);
		expect(pos.y).toBe(4);
	});
});

describe("pointInside", () => {
	test("is inclusive on the top-left and exclusive on the bottom-right", () => {
		const area = { x: 10, y: 20, width: 30, height: 40 };
		expect(pointInside({ x: 10, y: 20 }, area)).toBe(true);
		expect(pointInside({ x: 39, y: 59 }, area)).toBe(true);
		expect(pointInside({ x: 40, y: 60 }, area)).toBe(false);
		expect(pointInside(null, area)).toBe(false);
	});
});
