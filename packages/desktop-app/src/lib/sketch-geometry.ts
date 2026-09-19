/**
 * SketchPad geometry — the pure half of the drawing board.
 *
 * Why this file exists: `SketchPad.tsx` renders through react-konva, and the
 * shape maths (bounding boxes, star/heart point generation, hit areas) sits
 * between "user drags" and "pixels", where a mistake is invisible until you
 * export. Konva cannot be asserted against without a canvas, so every
 * coordinate decision lives here as a plain function and gets unit-tested
 * (test/sketch-geometry.test.ts). The component keeps only the wiring.
 *
 * Coordinate contract (unchanged from the original inline maths, 2026-09-19
 * Codex-parity pass): every shape stroke stores exactly four numbers
 * `[x0, y0, x1, y1]` — the two corners of the drag rectangle. Pen strokes
 * store flat `[x, y, pressure, …]` triplets instead. `shiftPoints` and
 * `scalePoints` rely on that split, so no shape may store anything else.
 */

/** Tools that draw a drag-rectangle shape (4-number points) rather than ink. */
export type ShapeTool = "line" | "arrow" | "rect" | "ellipse" | "diamond" | "triangle" | "star" | "heart";

/** Every tool the board can arm. `eraser` and `select` are gestures, not shapes. */
export type Tool = "select" | "pen" | "eraser" | "text" | ShapeTool;

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A drag is below the commit threshold when both deltas are shorter than this. */
export const MIN_DRAG = 2;

/** Normalize the two drag corners into a positive-extent box. */
export function dragBox(x0: number, y0: number, x1: number, y1: number): Rect {
	return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** A drag that produced nothing (a tap with a shape tool armed). Committing
 *  such a stroke would leave an invisible zero-size node that still consumes
 *  undo steps and swallows hit-tests. */
export function isDegenerateDrag(x0: number, y0: number, x1: number, y1: number): boolean {
	return Math.abs(x1 - x0) < MIN_DRAG && Math.abs(y1 - y0) < MIN_DRAG;
}

/** Does this drag hold a usable shape? Shared by every shape tool so the
 *  tap-vs-drag rule can never drift between them. */
export function acceptsShapeDrag(_tool: ShapeTool, points: readonly number[]): boolean {
	const [x0, y0, x1, y1] = points;
	return !isDegenerateDrag(x0, y0, x1, y1);
}

/**
 * A star's alternating outer/inner radius points, relative to the shape's
 * centre. Konva's own `Star` node exists, but its `numPoints` is an integer
 * count and it cannot express the Codex flyout's sharper 5-point look with a
 * controlled inner ratio, so the points are generated here and rendered as a
 * closed `Line` — one code path for star and heart both.
 */
export function starOuterPoints(box: Rect, points = 5, innerRatio = 0.42): number[] {
	const cx = box.x + box.w / 2;
	const cy = box.y + box.h / 2;
	const rx = box.w / 2;
	const ry = box.h / 2;
	const out: number[] = [];
	for (let i = 0; i < points * 2; i++) {
		const r = i % 2 === 0 ? 1 : innerRatio;
		// Start at -90° so the first spike points straight up.
		const a = (Math.PI * i) / points - Math.PI / 2;
		out.push(cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r);
	}
	return out;
}

/**
 * Heart outline sampled from the classic parametric curve, mapped onto the
 * drag box.
 *
 * The raw curve spans x∈[−16,16] and y∈[−17,11.92] — the y range is both
 * asymmetric and taller than the x range, so naively dividing by a single
 * constant lets the bottom tip hang 13% below the box *and* shifts the
 * comparison. Both axes are therefore normalized against their own measured
 * extremes, which is what makes the heart actually fill the rectangle the
 * user dragged (asserted in test/sketch-geometry.test.ts).
 *
 * Sampled rather than a fixed Bezier path because the shape must stretch with
 * the pointer, and a ~48-point `Line` is cheaper than scaling a path.
 */
export function heartPoints(box: Rect, samples = 48): number[] {
	const cx = box.x + box.w / 2;
	const cy = box.y + box.h / 2;
	const sx = box.w / 2;
	const sy = box.h / 2;
	// Raw extremes of y = 13cos t − 5cos2t − 2cos3t − cos4t over a full sweep.
	const RAW_Y_MIN = -17;
	const RAW_Y_MAX = 11.9233;
	const out: number[] = [];
	for (let i = 0; i < samples; i++) {
		const t = (i / samples) * Math.PI * 2;
		const hx = 16 * Math.sin(t) ** 3;
		const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
		// x: symmetric about 0, so its own half-range (16) is the divisor.
		// y: shifted to [−1,1] and scaled — screen y grows downward, hence the
		// leading minus on the hy term.
		const nx = hx / 16;
		const ny = (hy * 2 - (RAW_Y_MAX + RAW_Y_MIN)) / (RAW_Y_MAX - RAW_Y_MIN);
		out.push(cx + nx * sx, cy - ny * sy);
	}
	return out;
}

/** Outline point-set for the shapes that are not a plain box primitive.
 *  Returns `null` for tools that render as a Konva primitive. */
export function outlinePoints(tool: ShapeTool, points: readonly number[]): number[] | null {
	const box = dragBox(points[0], points[1], points[2], points[3]);
	if (tool === "star") return starOuterPoints(box);
	if (tool === "heart") return heartPoints(box);
	if (tool === "triangle") {
		return [box.x + box.w / 2, box.y, box.x + box.w, box.y + box.h, box.x, box.y + box.h];
	}
	if (tool === "diamond") {
		return [
			box.x + box.w / 2,
			box.y,
			box.x + box.w,
			box.y + box.h / 2,
			box.x + box.w / 2,
			box.y + box.h,
			box.x,
			box.y + box.h / 2,
		];
	}
	return null;
}

/** Stroke thickness → rendered glyph size for a text label. Kept here rather
 *  than inline so the Konva `Text` node and the select tool's dashed frame
 *  measure the same box; when these drifted the frame clipped through the
 *  glyphs. */
export function textFontSize(size: number): number {
	return Math.max(14, size * 4);
}

/** Measured extent of a text label, from the glyph size Konva will use.
 *  The 0.62 factor approximates the average advance width of the UI sans at
 *  this size — good enough for a hit box, and deliberately generous. */
export function textLabelBox(size: number, label: string): { w: number; h: number } {
	const fs = textFontSize(size);
	return { w: Math.max(20, label.length * fs * 0.62), h: Math.max(20, fs * 1.3) };
}

/**
 * Unpadded extent of a stroke's own coordinates. Shapes are the min/max of
 * their two corners, pen walks the triplets, and text contributes only its
 * anchor (the label extent is `strokeBox`'s concern). The select tool's
 * scale handles take their anchor — the corner opposite the grabbed one —
 * from this rather than from the padded frame, so the content corner the
 * user is dragging away from stays visually pinned during the scale.
 */
export function strokeExtent(s: { tool: Tool; points: readonly number[] }): Rect {
	if (s.tool === "text") {
		return { x: s.points[0], y: s.points[1], w: 0, h: 0 };
	}
	if (s.tool === "pen") {
		// Flat [x,y,pressure,…] triplets; pressure is skipped.
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (let i = 0; i + 1 < s.points.length; i += 3) {
			if (s.points[i] < minX) minX = s.points[i];
			if (s.points[i + 1] < minY) minY = s.points[i + 1];
			if (s.points[i] > maxX) maxX = s.points[i];
			if (s.points[i + 1] > maxY) maxY = s.points[i + 1];
		}
		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
	}
	const [x0, y0, x1, y1] = s.points;
	return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * Translate a stroke's points by (dx,dy). Stride handling is per-tool on
 * purpose — the same split `strokeBox` walks: pen carries a pressure value
 * at every third slot that must pass through untouched, shapes are a flat
 * four-number box, text is a two-number anchor.
 *
 * This replaces the inline `i % 3` / `i % 2` mix the component used before
 * 2026-09-19: on pen input that formula handed x-slots the y delta and vice
 * versa (index 3 is an x but odd, index 4 is a y but even), shearing every
 * diagonal drag of pen ink. It was never covered because it lived beside
 * the component, where Konva cannot be asserted without a canvas.
 */
export function shiftPoints(tool: Tool, points: readonly number[], dx: number, dy: number): number[] {
	if (tool === "pen") {
		const out: number[] = [];
		for (let i = 0; i + 2 < points.length; i += 3) {
			out.push(points[i] + dx, points[i + 1] + dy, points[i + 2]);
		}
		return out;
	}
	if (tool === "text") {
		return [points[0] + dx, points[1] + dy];
	}
	return [points[0] + dx, points[1] + dy, points[2] + dx, points[3] + dy];
}

/** Scale-factor bounds so a wild pointer can neither fold a stroke through
 *  its anchor (→ an un-clickable dot) nor fling it into a coordinate range
 *  where the exporter breaks down. */
const SCALE_FACTOR_MIN = 0.05;
const SCALE_FACTOR_MAX = 40;

/**
 * Uniformly scale a stroke about the anchor (ax,ay): every point moves to
 * `a + (p − a) · factor`. This is the maths behind the select tool's corner
 * handles. It lives here rather than as a Konva `scale` on the node because
 * replaying the transform back into `points` keeps the stored data
 * resolution-independent, avoids Konva's stroke-width distortion under
 * node scale, and lets the existing move op undo/redo it unchanged.
 *
 * Pen pressure values pass through untouched — pressure is ink
 * expressiveness, not geometry.
 */
export function scalePoints(tool: Tool, points: readonly number[], ax: number, ay: number, factor: number): number[] {
	const f = Math.min(SCALE_FACTOR_MAX, Math.max(SCALE_FACTOR_MIN, factor));
	if (tool === "pen") {
		const out: number[] = [];
		for (let i = 0; i + 2 < points.length; i += 3) {
			out.push(ax + (points[i] - ax) * f, ay + (points[i + 1] - ay) * f, points[i + 2]);
		}
		return out;
	}
	if (tool === "text") {
		return [ax + (points[0] - ax) * f, ay + (points[1] - ay) * f];
	}
	return [ax + (points[0] - ax) * f, ay + (points[1] - ay) * f, ax + (points[2] - ax) * f, ay + (points[3] - ay) * f];
}

/**
 * Bounding box of a stroke, padded for line width — the select tool draws its
 * dashed frame from this, and `onPointerDown` uses it to decide whether a
 * finger landed on a text label.
 */
export function strokeBox(s: { tool: Tool; size: number; points: readonly number[] }, text = ""): Rect {
	const pad = s.size * 1.8 + 4;
	if (s.tool === "text") {
		// Text stores only its anchor, so the label is what gives it an extent.
		const { w, h } = textLabelBox(s.size, text);
		return { x: s.points[0] - pad, y: s.points[1] - pad, w: w + pad * 2, h: h + pad * 2 };
	}
	const e = strokeExtent(s);
	return { x: e.x - pad, y: e.y - pad, w: e.w + pad * 2, h: e.h + pad * 2 };
}

/** Does `points` describe a box the user can actually see? Used to keep the
 *  export from resizing around a hidden zero-size node. */
export function hasVisibleExtent(s: { tool: Tool; points: readonly number[] }): boolean {
	if (s.tool === "text") return s.points[0] > 0 && s.points[1] > 0;
	if (s.tool === "pen") return s.points.length >= 6;
	const [x0, y0, x1, y1] = s.points;
	return Math.abs(x1 - x0) >= MIN_DRAG || Math.abs(y1 - y0) >= MIN_DRAG;
}
