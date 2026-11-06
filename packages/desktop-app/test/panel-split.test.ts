import { describe, expect, it } from "bun:test";
import {
	clampPanelSplitRatio,
	DEFAULT_PANEL_SPLIT_RATIO,
	nudgePanelSplitRatio,
	PANEL_SPLIT_DIVIDER_PX,
	PANEL_SPLIT_MAX_RATIO,
	PANEL_SPLIT_MIN_COLUMN_PX,
	PANEL_SPLIT_MIN_RATIO,
	type PanelTabState,
	panelSplitMinRatio,
	panelSplitRatio,
	panelSplitRatioAt,
	restorePanelTabs,
	serializePanelTabs,
	setPanelSplitRatio,
} from "../src/lib/panel-tabs";

// The split divider's geometry and persistence. The drag itself is a pointer
// gesture over these pure results: pointer x maps to column 0's share, a pixel
// minimum keeps both columns usable, and the share travels with the panel's
// per-session layout.

const state = (splitRatio?: number): PanelTabState => ({
	tabs: [],
	activeId: null,
	split: true,
	columnActive: [null, null],
	splitRatio,
});

describe("panel split geometry", () => {
	it("maps the pointer to column 0's share of the track", () => {
		// Track 800px wide starting at 100: half is x = 100 + 400 + 3.5.
		const ratio = panelSplitRatioAt(100 + 400 + PANEL_SPLIT_DIVIDER_PX / 2, { left: 100, available: 800 });
		expect(ratio).toBeCloseTo(0.5, 6);
		// The left edge is a 160px column of an 800px track, not zero.
		expect(panelSplitRatioAt(100, { left: 100, available: 800 })).toBeCloseTo(0.2, 6);
	});

	it("keeps the pixel minimum on both sides", () => {
		const track = { left: 0, available: 1000 };
		const min = PANEL_SPLIT_MIN_COLUMN_PX / 1000;
		expect(panelSplitRatioAt(0, track)).toBeCloseTo(min, 6);
		expect(panelSplitRatioAt(5000, track)).toBeCloseTo(1 - min, 6);
	});

	it("degrades the minimum to half the track in a narrow panel", () => {
		// 260px cannot hold two 160px columns; both sides stay reachable at half.
		expect(panelSplitMinRatio(260)).toBe(0.5);
		expect(panelSplitRatioAt(0, { left: 0, available: 260 })).toBe(0.5);
		expect(panelSplitRatioAt(999, { left: 0, available: 260 })).toBe(0.5);
	});

	it("falls back to the structural floor before the track is measured", () => {
		expect(panelSplitMinRatio(0)).toBe(PANEL_SPLIT_MIN_RATIO);
		expect(panelSplitRatioAt(500, { left: 0, available: 0 })).toBe(DEFAULT_PANEL_SPLIT_RATIO);
	});

	it("steps the share inside the same limits for keyboard users", () => {
		expect(nudgePanelSplitRatio(0.5, 0.02, 1000)).toBeCloseTo(0.52, 6);
		expect(nudgePanelSplitRatio(0.5, -0.02, 1000)).toBeCloseTo(0.48, 6);
		// 160px of a 1000px track is the floor, so stepping left stops there.
		expect(nudgePanelSplitRatio(0.2, -0.1, 1000)).toBeCloseTo(0.16, 6);
		expect(nudgePanelSplitRatio(0.2, 0.1, 1000)).toBeCloseTo(0.3, 6);
	});
});

describe("panel split state", () => {
	it("defaults to the even split and clamps out-of-range shares", () => {
		expect(panelSplitRatio({})).toBe(DEFAULT_PANEL_SPLIT_RATIO);
		expect(panelSplitRatio({ splitRatio: 0.9 })).toBe(PANEL_SPLIT_MAX_RATIO);
		expect(panelSplitRatio({ splitRatio: 0.01 })).toBe(PANEL_SPLIT_MIN_RATIO);
		expect(panelSplitRatio({ splitRatio: Number.NaN })).toBe(DEFAULT_PANEL_SPLIT_RATIO);
		expect(clampPanelSplitRatio(0.4)).toBe(0.4);
	});

	it("keeps the state reference when the share does not move", () => {
		const s = state(0.4);
		expect(setPanelSplitRatio(s, 0.4)).toBe(s);
		expect(setPanelSplitRatio(s, 0.6).splitRatio).toBe(0.6);
	});

	it("persists the share and restores it", () => {
		const serialized = serializePanelTabs(state(0.35));
		expect(serialized.splitRatio).toBe(0.35);
		expect(restorePanelTabs(serialized).splitRatio).toBe(0.35);
	});

	it("restores the even split from layouts written before the divider", () => {
		const legacy = { v: 2 as const, split: true, tabs: [], activeId: null, columnActive: [null, null] };
		expect(restorePanelTabs(legacy).splitRatio).toBe(DEFAULT_PANEL_SPLIT_RATIO);
	});
});
