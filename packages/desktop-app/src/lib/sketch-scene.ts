/**
 * SketchPad scene persistence — the editable half of a finished board.
 *
 * Why this file exists: `完成` exports a PNG and the composer turns that PNG
 * into an image chip (A1). Clicking A1 used to mount the PNG back into the
 * board as one flat picture, so the drawing that produced it (A0) was gone —
 * a bitmap you could only paint on top of, never take apart. The board's real
 * content is its stroke list, so finishing now also hands over a **scene**
 * (the strokes plus the board size they were drawn in), and re-opening a chip
 * restores that list: every pen stroke, shape and label comes back as its own
 * selectable / movable / erasable object.
 *
 * The scene rides on the chip (`sketchScene`) and, like the chip itself, is
 * best-effort: a draft restore that cannot carry it (oversized payload, or a
 * scene holding an imported picture) drops just the scene and falls back to
 * the old flat-image reopen rather than losing the attachment.
 *
 * Pure data + pure functions: no Konva, so it is unit-testable
 * (test/sketch-scene.test.ts) and the parser can be shaped by a stored value
 * that outlived a format change.
 */

import { TEXT_MIN_W, type TextMeasure, type Tool, textAutoBox, textFontSize } from "./sketch-geometry";

/** Box a legacy two-number text anchor migrates to. The old format measured
 *  its label at paint time with no wrap width, so the closest honest reading
 *  is "one line, no wrapping" — a width generous enough to hold the label
 *  without reflowing it, which is exactly how it looked before the change.
 *  `measure` is optional so this module stays canvas-free; without it the
 *  label falls back to the Latin estimate, which under-measures CJK and can
 *  therefore wrap a migrated Chinese label that used to sit on one line. */
function legacyTextBox(
	x: number,
	y: number,
	label: string,
	size: number,
	measure?: TextMeasure,
): [number, number, number, number] {
	const fs = textFontSize(size);
	const natural = Math.max(TEXT_MIN_W, (measure ?? ((t, s) => t.length * s * 0.62))(label, fs));
	const fit = textAutoBox(size, label, natural, measure);
	return [x, y, Math.max(natural, fit.w), fit.h];
}

/** The stroke record the board paints and the scene stores. `eraser` is a
 *  gesture, not a drawn object, so it is not a valid stroke tool. */
export interface SketchStroke {
	id: number;
	tool: Exclude<Tool, "eraser">;
	color: string;
	size: number;
	/** pen: flat [x,y,pressure,…]; shapes: [x0,y0,x1,y1]; text: [x,y,w,h] box;
	 *  image: [x,y,width,height]. */
	points: number[];
	/** text only: the label. */
	text?: string;
	/** image only: the data/remote URL the Konva image node decodes from. */
	src?: string;
}

/** A saved board. `w`/`h` are the board size the strokes were drawn in —
 *  restoring into a differently sized board rescales them (see
 *  `sceneStrokesFor`), which is what keeps a re-opened sketch from drifting
 *  out of frame after a window resize. */
export interface SketchScene {
	/** Format version: a stored scene with an unknown `v` is rejected rather
	 *  than half-understood. */
	v: 1;
	w: number;
	h: number;
	strokes: SketchStroke[];
}

/** Every tool that can appear in a scene. Anything else (a typo, a future
 *  tool this build cannot render) is rejected at parse time. */
const STROKE_TOOLS: readonly string[] = [
	"pen",
	"text",
	"image",
	"line",
	"arrow",
	"rect",
	"ellipse",
	"diamond",
	"triangle",
	"star",
	"heart",
];

/** Coordinate precision kept on serialize: 0.1px is far below what an ink
 *  stroke can show, and it is what keeps a busy scene out of the megabytes
 *  (a long pen drag is thousands of triplets). */
function roundCoord(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Pressure keeps two decimals — it is a 0..1 curve, not a position. */
function roundPressure(n: number): number {
	return Math.round(n * 100) / 100;
}

/** Snapshot the live board as a scene. Non-finite coordinates are dropped to
 *  0 rather than serialized as `null` (a NaN in Konva silently blanks the
 *  whole node, so it must never reach storage). */
export function serializeScene(strokes: readonly SketchStroke[], w: number, h: number): SketchScene {
	return {
		v: 1,
		w: Math.round(w) || 0,
		h: Math.round(h) || 0,
		strokes: strokes.map(s => {
			const isPen = s.tool === "pen";
			return {
				id: s.id,
				tool: s.tool,
				color: s.color,
				size: roundCoord(s.size),
				points: s.points.map((p, i) => {
					const v = Number.isFinite(p) ? p : 0;
					return isPen && i % 3 === 2 ? roundPressure(v) : roundCoord(v);
				}),
				...(typeof s.text === "string" ? { text: s.text } : {}),
				...(typeof s.src === "string" ? { src: s.src } : {}),
			};
		}),
	};
}

/** Expected `points` length per tool: pen is a multiple of three (checked
 *  separately), everything else is a fixed-width record. */
function expectedPointCount(tool: string): number | null {
	// Text and image both store a box [x, y, w, h].
	if (tool === "text") return 4;
	if (tool === "image") return 4;
	return 4;
}

/** Validate one stored stroke. Returns `null` for junk rather than throwing:
 *  a single corrupt entry must not cost the user the rest of the board. */
function parseStroke(raw: unknown): SketchStroke | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.tool !== "string" || !STROKE_TOOLS.includes(r.tool)) return null;
	if (typeof r.color !== "string") return null;
	if (typeof r.size !== "number" || !Number.isFinite(r.size)) return null;
	if (typeof r.id !== "number" || !Number.isFinite(r.id)) return null;
	if (!Array.isArray(r.points)) return null;
	const points: number[] = [];
	for (const p of r.points) {
		const v = typeof p === "number" ? p : Number(p);
		if (!Number.isFinite(v)) return null;
		points.push(v);
	}
	if (r.tool === "pen") {
		// A pen stroke is whole triplets; a truncated tail would leave the
		// last point without its pressure and shear the ink.
		if (points.length < 3 || points.length % 3 !== 0) return null;
	} else if (r.tool === "text" && points.length === 2) {
		// Legacy text (before the box contract) stored a bare [x, y] anchor and
		// measured its own label at paint time. Restore it as a box so the
		// label keeps its own wrap width instead of losing the stroke. The
		// migration REPLACES the pair — the box already carries the origin.
		const [x, y] = points;
		points.length = 0;
		points.push(...legacyTextBox(x, y, typeof r.text === "string" ? r.text : "", r.size));
	} else {
		const n = expectedPointCount(r.tool);
		if (n !== null && points.length !== n) return null;
	}
	const out: SketchStroke = {
		id: r.id,
		tool: r.tool as SketchStroke["tool"],
		color: r.color,
		size: r.size,
		points,
	};
	if (typeof r.text === "string") out.text = r.text;
	if (typeof r.src === "string") out.src = r.src;
	return out;
}

/** Parse a stored scene (draft payload, unknown JSON). `null` when the value
 *  is not a usable board — the caller then falls back to reopening the chip
 *  as a flat image. */
export function parseSketchScene(raw: unknown): SketchScene | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1) return null;
	if (typeof r.w !== "number" || typeof r.h !== "number") return null;
	if (!Array.isArray(r.strokes)) return null;
	const strokes: SketchStroke[] = [];
	for (const entry of r.strokes) {
		const s = parseStroke(entry);
		if (s) strokes.push(s);
	}
	return { v: 1, w: r.w, h: r.h, strokes };
}

/** Does the scene hold an imported picture? Such a scene carries a second
 *  full-size base64 payload, so the draft stash refuses it (the in-memory
 *  chip still keeps it — only the localStorage round-trip drops it). */
export function sceneHasImage(scene: SketchScene): boolean {
	return scene.strokes.some(s => s.tool === "image");
}

/** Uniform rescale factor from the stored board size to the current one.
 *  Uniform (not per-axis) so a re-opened drawing keeps its proportions. */
function sceneFactor(scene: SketchScene, w: number, h: number): number {
	if (!(scene.w > 0) || !(scene.h > 0) || !(w > 0) || !(h > 0)) return 1;
	const f = Math.min(w / scene.w, h / scene.h);
	if (!Number.isFinite(f) || f <= 0) return 1;
	// Sub-1% differences are a resize blink, not a new board: skipping the
	// rescale keeps a re-opened stroke pixel-identical to what was saved.
	return Math.abs(f - 1) < 0.01 ? 1 : f;
}

/** Strokes of a restored scene, rescaled into the board that is about to
 *  paint them. Pressure passes through untouched (it is ink expressiveness,
 *  not geometry); stroke thickness follows the same factor so a scaled-up
 *  board does not come back hairline-thin. */
export function sceneStrokesFor(scene: SketchScene, w: number, h: number): SketchStroke[] {
	const f = sceneFactor(scene, w, h);
	if (f === 1) return scene.strokes;
	return scene.strokes.map(s => ({
		...s,
		size: Math.max(0.5, s.size * f),
		points: s.points.map((p, i) => (s.tool === "pen" && i % 3 === 2 ? p : p * f)),
	}));
}

/** Next free stroke id for a restored board, so new ink never collides with
 *  a restored stroke (two nodes sharing an id break hit-testing: the eraser
 *  and the select tool would both target the wrong object). */
export function nextStrokeId(strokes: readonly SketchStroke[]): number {
	let max = 0;
	for (const s of strokes) if (s.id > max) max = s.id;
	return max + 1;
}
