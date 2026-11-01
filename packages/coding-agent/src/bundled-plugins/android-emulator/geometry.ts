export interface ScreenPoint {
	x: number;
	y: number;
}

export interface ScreenRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface ScreenSize {
	width: number;
	height: number;
}

export function mapPoint(rect: ScreenRect, natural: ScreenSize, client: ScreenPoint): ScreenPoint | null {
	if (rect.width <= 0 || rect.height <= 0 || natural.width <= 0 || natural.height <= 0) return null;
	if (
		client.x < rect.left ||
		client.y < rect.top ||
		client.x >= rect.left + rect.width ||
		client.y >= rect.top + rect.height
	)
		return null;
	return {
		x: Math.round(((client.x - rect.left) / rect.width) * natural.width),
		y: Math.round(((client.y - rect.top) / rect.height) * natural.height),
	};
}
