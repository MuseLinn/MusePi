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
