import { ToolError } from "../tool-errors";
import type { BrowserVisualSnapshot } from "./snapshots";

export interface BrowserVisualRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BrowserVisualCrop {
	sourceSnapshotId: string;
	region: BrowserVisualRegion;
	image: {
		dest: string;
		mimeType: "image/png";
		bytes: number;
		width: number;
		height: number;
	};
	capturedAt: string;
}

export function resolveVisualCrop(
	snapshot: BrowserVisualSnapshot,
	region: BrowserVisualRegion,
	sourceWidth: number,
	sourceHeight: number,
): { left: number; top: number; width: number; height: number } {
	if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
		throw new ToolError("Visual snapshot source image has invalid dimensions");
	}
	const values = [region.x, region.y, region.width, region.height];
	if (!values.every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
		throw new ToolError("Visual crop region must have nonnegative x/y and positive width/height");
	}
	if (region.x + region.width > snapshot.image.width || region.y + region.height > snapshot.image.height) {
		throw new ToolError(`Visual crop region is outside snapshot ${snapshot.snapshotId}`);
	}
	const scaleX = sourceWidth / snapshot.image.width;
	const scaleY = sourceHeight / snapshot.image.height;
	const left = Math.floor(region.x * scaleX);
	const top = Math.floor(region.y * scaleY);
	const right = Math.min(sourceWidth, Math.ceil((region.x + region.width) * scaleX));
	const bottom = Math.min(sourceHeight, Math.ceil((region.y + region.height) * scaleY));
	if (right <= left || bottom <= top) throw new ToolError("Visual crop region is too small to produce an image");
	return { left, top, width: right - left, height: bottom - top };
}
