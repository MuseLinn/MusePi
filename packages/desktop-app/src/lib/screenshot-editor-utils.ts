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

export interface ScreenshotRegion extends Region {
	type: "select" | "arrow";
}

interface TextAnnotation extends Point {
	text: string;
	type: "text";
}

export type ScreenshotAnnotation = ScreenshotRegion | TextAnnotation;

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

function drawRegion(
	ctx: CanvasRenderingContext2D,
	region: ScreenshotRegion,
	scale: number,
	offsetX: number,
	offsetY: number,
): void {
	ctx.save();
	ctx.strokeStyle = "#4ade80";
	ctx.lineWidth = 1.5;
	ctx.setLineDash([6, 4]);
	ctx.strokeRect(
		(region.x0 - offsetX) * scale,
		(region.y0 - offsetY) * scale,
		(region.x1 - region.x0) * scale,
		(region.y1 - region.y0) * scale,
	);
	ctx.restore();
}

export function drawAnnotations(
	ctx: CanvasRenderingContext2D,
	annotations: readonly ScreenshotAnnotation[],
	options: { scale: number; offsetX?: number; offsetY?: number },
): void {
	const { scale, offsetX = 0, offsetY = 0 } = options;
	for (const annotation of annotations) {
		if (annotation.type === "text") {
			ctx.fillStyle = "#f87171";
			ctx.font = `${14 * scale}px sans-serif`;
			ctx.fillText(annotation.text, (annotation.x - offsetX) * scale, (annotation.y - offsetY) * scale);
			continue;
		}
		if (annotation.type === "select") {
			drawRegion(ctx, annotation, scale, offsetX, offsetY);
			continue;
		}
		const x0 = (annotation.x0 - offsetX) * scale;
		const y0 = (annotation.y0 - offsetY) * scale;
		const x1 = (annotation.x1 - offsetX) * scale;
		const y1 = (annotation.y1 - offsetY) * scale;
		const angle = Math.atan2(y1 - y0, x1 - x0);
		const length = 12 * scale;
		ctx.strokeStyle = "#f87171";
		ctx.lineWidth = 2 * scale;
		ctx.beginPath();
		ctx.moveTo(x0, y0);
		ctx.lineTo(x1, y1);
		ctx.lineTo(x1 - length * Math.cos(angle - 0.5), y1 - length * Math.sin(angle - 0.5));
		ctx.moveTo(x1, y1);
		ctx.lineTo(x1 - length * Math.cos(angle + 0.5), y1 - length * Math.sin(angle + 0.5));
		ctx.stroke();
	}
}
