import { describe, expect, it } from "bun:test";
import type { ClientRect } from "@dnd-kit/core";
import { type PanelDropQuery, type PanelDropZone, resolvePanelDrop } from "../src/lib/panel-tab-dnd";

// Drop resolution for the panel strips: containment is the authority (a chip
// beats the column that contains it), a same-column zone release reorders via
// the nearest chip, the split target means "new column" and never reorders,
// and a release just off the strip still lands on the nearest chip.

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
	left,
	top,
	right: left + width,
	bottom: top + height,
	width,
	height,
});

// Two chips per column, 100px wide, 26px tall.
const chipRects = new Map<string, ClientRect>([
	["a", rect(0, 0, 100, 26)],
	["b", rect(104, 0, 100, 26)],
	["c", rect(0, 0, 100, 26)],
	["d", rect(104, 0, 100, 26)],
]);

const query = (over: Partial<PanelDropQuery> & Pick<PanelDropQuery, "pointer">): PanelDropQuery => ({
	activeId: "a",
	rects: chipRects,
	tabs: [
		{ id: "a", column: 0 },
		{ id: "b", column: 0 },
		{ id: "c", column: 1 },
		{ id: "d", column: 1 },
	],
	zones: [
		{ id: "panel-col-0", column: 0 },
		{ id: "panel-col-1", column: 1 },
	] satisfies PanelDropZone[],
	...over,
});

const withZones = (zones: PanelDropZone[], extra: Partial<PanelDropQuery> = {}): PanelDropQuery =>
	query({
		pointer: { x: 500, y: 500 },
		rects: new Map([...chipRects, ["panel-split-zone", rect(300, 100, 200, 200)]]),
		zones,
		...extra,
	});

describe("resolvePanelDrop", () => {
	it("prefers the chip under the pointer over the column that contains it", () => {
		const colRect = rect(0, 0, 400, 60);
		const result = resolvePanelDrop(
			query({
				pointer: { x: 50, y: 13 },
				rects: new Map([...chipRects, ["panel-col-0", colRect]]),
				zones: [{ id: "panel-col-0", column: 0 }],
			}),
		);
		expect(result).toEqual({ id: "a", kind: "tab" });
	});

	it("falls back to the column's nearest chip when released in a gap", () => {
		const colRect = rect(0, 0, 400, 60);
		const result = resolvePanelDrop(
			query({
				// 2px gap between chips a and b, still inside column 0.
				pointer: { x: 102, y: 13 },
				rects: new Map([...chipRects, ["panel-col-0", colRect]]),
				zones: [{ id: "panel-col-0", column: 0 }],
			}),
		);
		expect(result?.kind).toBe("tab");
		expect(["a", "b"]).toContain(result?.id ?? "");
	});

	it("keeps a cross-column zone verdict instead of reordering in place", () => {
		const col1 = rect(400, 0, 400, 60);
		const result = resolvePanelDrop(
			query({
				pointer: { x: 500, y: 40 },
				rects: new Map([...chipRects, ["panel-col-1", col1]]),
				zones: [{ id: "panel-col-1", column: 1 }],
			}),
		);
		expect(result).toEqual({ id: "panel-col-1", kind: "zone" });
	});

	it("never routes the split target through the reorder fallback", () => {
		// Pointer inside column 0's zone AND inside the split target: the split
		// zone is smaller, so containment picks it and no chip fallback applies.
		const result = resolvePanelDrop(
			withZones([{ id: "panel-split-zone", column: 0, kind: "split" }], {
				pointer: { x: 350, y: 150 },
				rects: new Map([
					...chipRects,
					["panel-col-0", rect(0, 0, 600, 400)],
					["panel-split-zone", rect(300, 100, 200, 200)],
				]),
				zones: [
					{ id: "panel-col-0", column: 0 },
					{ id: "panel-split-zone", column: 0, kind: "split" },
				],
			}),
		);
		expect(result).toEqual({ id: "panel-split-zone", kind: "zone" });
	});

	it("skips the dragged chip when resolving its own column's gap", () => {
		// Drag "a", release in column 0's body below the strip: the verdict must
		// be "b", not a self-drop that would no-op.
		const result = resolvePanelDrop(
			query({
				activeId: "a",
				pointer: { x: 20, y: 100 },
				rects: new Map([...chipRects, ["panel-col-0", rect(0, 0, 400, 200)]]),
				zones: [{ id: "panel-col-0", column: 0 }],
			}),
		);
		expect(result).toEqual({ id: "b", kind: "tab" });
	});

	it("lands on the nearest chip when released just off the strip", () => {
		const result = resolvePanelDrop(query({ pointer: { x: 50, y: 40 } }));
		expect(result).toEqual({ id: "a", kind: "tab" });
	});

	it("returns null when the pointer is far from every target", () => {
		const result = resolvePanelDrop(query({ pointer: { x: 2000, y: 2000 } }));
		expect(result).toBeNull();
	});

	it("reaches a wide chip from just outside its edge", () => {
		// A 200px chip: the pointer sits 40px right of its edge, beyond a
		// centre-distance radius but still within the 48px box fallback.
		const result = resolvePanelDrop(
			query({
				pointer: { x: 240, y: 13 },
				rects: new Map([["a", rect(0, 0, 200, 26)]]),
				tabs: [{ id: "a", column: 0 }],
				zones: [],
			}),
		);
		expect(result).toEqual({ id: "a", kind: "tab" });
	});

	it("honours a custom gap fallback distance", () => {
		// Chip a's box ends 14px above this pointer.
		const near = resolvePanelDrop(query({ pointer: { x: 50, y: 40 }, gapFallbackPx: 10 }));
		expect(near).toBeNull();
		const far = resolvePanelDrop(query({ pointer: { x: 50, y: 40 }, gapFallbackPx: 20 }));
		expect(far).toEqual({ id: "a", kind: "tab" });
	});
});
