/**
 * Viewport-preset fitting (openchamber `lib/browser/viewport.ts` parity).
 *
 * A responsive-check preset means: the page must LAY OUT at the preset's width
 * (that is the whole point — a 1440px page in a 420px panel renders the mobile
 * layout otherwise) and then be scaled DOWN to fit the panel. Scaling up is
 * never allowed, so 「自适应」(fit) stays a no-op.
 *
 * The fit is WIDTH-only: the presets here are widths, so a phone preset in a
 * wide-but-short panel must stay 1:1 and simply scroll vertically instead of
 * being shrunk by a height budget it never declared.
 */
export interface ViewportFit {
	/** Layout width the page keeps (the preset). */
	width: number;
	/** Visual scale applied to that layout, ≤ 1. */
	scale: number;
}

export function fitViewport(width: number, availWidth: number): ViewportFit {
	if (width <= 0 || availWidth <= 0) return { width, scale: 1 };
	return { width, scale: Math.min(1, availWidth / width) };
}

export type BrowserDisplayScale = "fit" | number;

export function resolveViewportScale(fitScale: number, displayScale: BrowserDisplayScale): number {
	if (displayScale === "fit") return fitScale;
	return Math.min(2, Math.max(0.25, displayScale));
}

export function clampViewportSize(width: number, height: number): { width: number; height: number } {
	return {
		width: Math.min(7680, Math.max(320, Math.round(width))),
		height: Math.min(4320, Math.max(480, Math.round(height))),
	};
}

export interface ViewportClip {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export function viewportClip(
	host: { x: number; y: number; width: number; height: number; scale: number },
	scrollport: { x: number; y: number; width: number; height: number },
): ViewportClip {
	return {
		top: Math.max(0, (scrollport.y - host.y) / host.scale),
		right: Math.max(0, (host.x + host.width * host.scale - scrollport.x - scrollport.width) / host.scale),
		bottom: Math.max(0, (host.y + host.height * host.scale - scrollport.y - scrollport.height) / host.scale),
		left: Math.max(0, (scrollport.x - host.x) / host.scale),
	};
}

export function viewportOverflow(
	layoutWidth: number,
	layoutHeight: number,
	scale: number,
	availableWidth: number,
	availableHeight: number,
): { x: boolean; y: boolean } {
	return {
		x: layoutWidth * scale > availableWidth,
		y: layoutHeight * scale > availableHeight,
	};
}
