import { measureTextWidth, TEXT_FONT_STACK, wrapTextLines } from "./sketch-geometry";

export interface RgbaPixel {
	r: number;
	g: number;
	b: number;
	a: number;
}

export function formatHex(pixel: RgbaPixel): string {
	const channel = (value: number): string => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
	return `#${channel(pixel.r)}${channel(pixel.g)}${channel(pixel.b)}`.toUpperCase();
}

export function formatRgba(pixel: RgbaPixel): string {
	const alpha = Math.round((pixel.a / 255) * 100) / 100;
	return `rgba(${pixel.r}, ${pixel.g}, ${pixel.b}, ${alpha})`;
}

export interface Point {
	x: number;
	y: number;
}

export interface Region {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Everything the screenshot editor can arm. `crop` edits the frame, `color`
 *  samples a pixel, `eraser` removes annotations; the rest draw. */
export type ShotTool = "pen" | "arrow" | "rect" | "ellipse" | "text" | "mosaic" | "crop" | "eraser" | "color";

export interface ShotStroke {
	id: number;
	tool: Exclude<ShotTool, "crop" | "eraser" | "color">;
	color: string;
	/** Line width in image pixels. Text uses it as the glyph size instead, so
	 *  one user-facing slider drives both ink weight and label size. */
	size: number;
	/** pen: flat [x,y,…]; shapes and mosaic: [x0,y0,x1,y1]; text: [x,y,w,h]. */
	points: number[];
	text?: string;
}

export function normalizeRegion(a: Point, b: Point): Region {
	return {
		x0: Math.min(a.x, b.x),
		y0: Math.min(a.y, b.y),
		x1: Math.max(a.x, b.x),
		y1: Math.max(a.y, b.y),
	};
}

export function clampRegion(region: Region, width: number, height: number): Region {
	const x0 = Math.max(0, Math.min(width, region.x0));
	const y0 = Math.max(0, Math.min(height, region.y0));
	const x1 = Math.max(0, Math.min(width, region.x1));
	const y1 = Math.max(0, Math.min(height, region.y1));
	return {
		x0: Math.min(x0, x1),
		y0: Math.min(y0, y1),
		x1: Math.max(x0, x1),
		y1: Math.max(y0, y1),
	};
}

export function regionSize(region: Region): { width: number; height: number } {
	return { width: region.x1 - region.x0, height: region.y1 - region.y0 };
}

/** A frame thinner than this in either axis is a click, not a selection. */
const MIN_REGION = 8;

export function isUsableRegion(region: Region): boolean {
	const { width, height } = regionSize(region);
	return width >= MIN_REGION && height >= MIN_REGION;
}

/** The bounding box an annotation occupies, padded by half its ink so the
 *  eraser and the frame include the stroke body. */
export function strokeRegion(stroke: ShotStroke): Region {
	const pad = stroke.tool === "text" ? 2 : Math.max(4, stroke.size / 2);
	if (stroke.tool === "pen") {
		let x0 = Number.POSITIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (let i = 0; i + 1 < stroke.points.length; i += 2) {
			x0 = Math.min(x0, stroke.points[i]!);
			y0 = Math.min(y0, stroke.points[i + 1]!);
			x1 = Math.max(x1, stroke.points[i]!);
			y1 = Math.max(y1, stroke.points[i + 1]!);
		}
		if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
		return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
	}
	if (stroke.tool === "text") {
		// Text stores a box [x, y, w, h], not two corners.
		return {
			x0: stroke.points[0]! - pad,
			y0: stroke.points[1]! - pad,
			x1: stroke.points[0]! + stroke.points[2]! + pad,
			y1: stroke.points[1]! + stroke.points[3]! + pad,
		};
	}
	return {
		x0: Math.min(stroke.points[0]!, stroke.points[2]!) - pad,
		y0: Math.min(stroke.points[1]!, stroke.points[3]!) - pad,
		x1: Math.max(stroke.points[0]!, stroke.points[2]!) + pad,
		y1: Math.max(stroke.points[1]!, stroke.points[3]!) + pad,
	};
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
	const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
	return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Does `point` land on the annotation's ink? `tolerance` is in image pixels
 *  and already includes the display→image conversion, so a thin arrow stays
 *  clickable at any preview scale. */
export function hitStroke(stroke: ShotStroke, point: Point, tolerance = 0): boolean {
	const reach = Math.max(3, stroke.size / 2) + tolerance;
	if (stroke.tool === "text" || stroke.tool === "mosaic") {
		const box = strokeRegion(stroke);
		return (
			point.x >= box.x0 - tolerance &&
			point.x <= box.x1 + tolerance &&
			point.y >= box.y0 - tolerance &&
			point.y <= box.y1 + tolerance
		);
	}
	const [x0, y0, x1, y1] = stroke.points;
	if (stroke.tool === "pen") {
		for (let i = 2; i + 1 < stroke.points.length; i += 2) {
			const a = { x: stroke.points[i - 2]!, y: stroke.points[i - 1]! };
			const b = { x: stroke.points[i]!, y: stroke.points[i + 1]! };
			if (distanceToSegment(point, a, b) <= reach) return true;
		}
		return false;
	}
	if (stroke.tool === "arrow") {
		return distanceToSegment(point, { x: x0!, y: y0! }, { x: x1!, y: y1! }) <= reach;
	}
	if (stroke.tool === "rect") {
		const left = Math.min(x0!, x1!);
		const right = Math.max(x0!, x1!);
		const top = Math.min(y0!, y1!);
		const bottom = Math.max(y0!, y1!);
		const nearVertical =
			(point.x >= left - reach && point.x <= left + reach) || (point.x >= right - reach && point.x <= right + reach);
		const nearHorizontal =
			(point.y >= top - reach && point.y <= top + reach) || (point.y >= bottom - reach && point.y <= bottom + reach);
		return (
			(nearVertical && point.y >= top - reach && point.y <= bottom + reach) ||
			(nearHorizontal && point.x >= left - reach && point.x <= right + reach)
		);
	}
	const cx = (x0! + x1!) / 2;
	const cy = (y0! + y1!) / 2;
	const rx = Math.max(1, Math.abs(x1! - x0!) / 2);
	const ry = Math.max(1, Math.abs(y1! - y0!) / 2);
	const normalized = Math.hypot((point.x - cx) / rx, (point.y - cy) / ry);
	// Ring thickness in normalized units, floored so a 1px stroke stays hit.
	const ring = Math.max(reach / Math.min(rx, ry), 0.08);
	return Math.abs(normalized - 1) <= ring;
}

/** Pixelated patch for a mosaic rect: one source pixel per block, painted
 *  back up with smoothing off. Tiny by construction (a 1600×900 region at a
 *  10px block is 160×90), so the preview and the export share it. */
export function buildMosaicPatch(source: CanvasImageSource, region: Region, block: number): HTMLCanvasElement | null {
	const width = Math.max(1, Math.round(region.x1 - region.x0));
	const height = Math.max(1, Math.round(region.y1 - region.y0));
	const size = Math.max(2, Math.round(block));
	const cols = Math.max(1, Math.ceil(width / size));
	const rows = Math.max(1, Math.ceil(height / size));
	const patch = document.createElement("canvas");
	patch.width = cols;
	patch.height = rows;
	const ctx = patch.getContext("2d");
	if (!ctx) return null;
	ctx.drawImage(source, region.x0, region.y0, width, height, 0, 0, cols, rows);
	return patch;
}

export interface DrawOptions {
	/** Display scale: 1 for a full-resolution export, the preview factor when
	 *  painting on screen. */
	scale: number;
	offsetX?: number;
	offsetY?: number;
	/** Resolve a mosaic stroke's pixelated patch. Missing patches paint
	 *  nothing rather than a misleading flat block. */
	mosaic?: (stroke: ShotStroke) => CanvasImageSource | null;
}

export function drawShotStrokes(
	ctx: CanvasRenderingContext2D,
	strokes: readonly ShotStroke[],
	options: DrawOptions,
): void {
	const { scale, offsetX = 0, offsetY = 0, mosaic } = options;
	for (const stroke of strokes) {
		ctx.save();
		ctx.strokeStyle = stroke.color;
		ctx.fillStyle = stroke.color;
		ctx.lineWidth = Math.max(1, stroke.size * scale);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const [x0, y0, x1, y1] = stroke.points;
		const ax = (x0! - offsetX) * scale;
		const ay = (y0! - offsetY) * scale;
		const bx = (x1! - offsetX) * scale;
		const by = (y1! - offsetY) * scale;

		if (stroke.tool === "pen") {
			paintInk(ctx, stroke, scale, offsetX, offsetY);
		} else if (stroke.tool === "arrow") {
			paintArrow(ctx, ax, ay, bx, by, stroke.size * scale);
		} else if (stroke.tool === "rect") {
			ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
		} else if (stroke.tool === "ellipse") {
			ctx.beginPath();
			ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
			ctx.stroke();
		} else if (stroke.tool === "text") {
			paintLabel(ctx, stroke, scale, offsetX, offsetY);
		} else if (stroke.tool === "mosaic") {
			const patch = mosaic?.(stroke);
			if (patch) {
				// Smoothing off is the whole effect: the patch is one pixel per
				// block, so nearest-neighbour upscaling is the mosaic.
				ctx.imageSmoothingEnabled = false;
				ctx.drawImage(patch, Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
			}
		}
		ctx.restore();
	}
}

function paintInk(
	ctx: CanvasRenderingContext2D,
	stroke: ShotStroke,
	scale: number,
	offsetX: number,
	offsetY: number,
): void {
	const points = stroke.points;
	if (points.length < 4) return;
	const x = (index: number): number => (points[index * 2]! - offsetX) * scale;
	const y = (index: number): number => (points[index * 2 + 1]! - offsetY) * scale;
	const count = Math.floor(points.length / 2);
	ctx.beginPath();
	ctx.moveTo(x(0), y(0));
	// Midpoint quadratics: the sampled pointer path is jagged at image
	// resolution, and a smoothed curve is what makes ink read as a stroke
	// instead of a polyline of mouse samples.
	for (let i = 1; i < count - 1; i++) {
		const midX = (x(i) + x(i + 1)) / 2;
		const midY = (y(i) + y(i + 1)) / 2;
		ctx.quadraticCurveTo(x(i), y(i), midX, midY);
	}
	ctx.lineTo(x(count - 1), y(count - 1));
	ctx.stroke();
}

function paintArrow(
	ctx: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	width: number,
): void {
	const angle = Math.atan2(y1 - y0, x1 - x0);
	const head = Math.max(10, width * 4);
	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x1 - head * Math.cos(angle - 0.45), y1 - head * Math.sin(angle - 0.45));
	ctx.lineTo(x1 - head * 0.62 * Math.cos(angle), y1 - head * 0.62 * Math.sin(angle));
	ctx.lineTo(x1 - head * Math.cos(angle + 0.45), y1 - head * Math.sin(angle + 0.45));
	ctx.closePath();
	ctx.fill();
}

function paintLabel(
	ctx: CanvasRenderingContext2D,
	stroke: ShotStroke,
	scale: number,
	offsetX: number,
	offsetY: number,
): void {
	const label = stroke.text ?? "";
	if (!label) return;
	const fontSize = Math.max(1, stroke.size * scale);
	const boxWidth = Math.max(fontSize, stroke.points[2]! * scale);
	ctx.font = `${fontSize}px ${TEXT_FONT_STACK}`;
	ctx.textBaseline = "top";
	const lines = wrapTextLines(label, boxWidth, fontSize, measureTextWidth);
	const lineHeight = fontSize * 1.3;
	const left = (stroke.points[0]! - offsetX) * scale;
	const top = (stroke.points[1]! - offsetY) * scale;
	lines.forEach((line, index) => {
		ctx.fillText(line, left, top + index * lineHeight);
	});
}
