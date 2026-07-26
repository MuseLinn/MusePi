/**
 * Shared box-drawing chrome for fullscreen overlays (settings, copy picker,
 * /queue viewer, …). Every helper paints with `theme.boxRound` glyphs
 * (rounded corners, sharp tee/cross junctions) and the `border`/`accent` theme
 * colors so all outlined overlays read identically.
 */
import { truncateToWidth, visibleWidth } from "@musepi/pi-tui";
import { theme } from "../theme/theme.ts";

function paint(s: string): string {
	return theme.fg("border", s);
}

/** Top border with an optional accent-colored title inset into the rule. */
export function topBorder(width: number, title: string): string {
	const box = theme.boxRound;
	const inner = Math.max(0, width - 2);
	if (!title) return paint(box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(box.topLeft + box.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		paint(box.horizontal.repeat(fillWidth) + box.topRight)
	);
}

/** A horizontal rule with left/right tees, splitting overlay sections. */
export function divider(width: number): string {
	const box = theme.boxRound;
	return paint(box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

export function bottomBorder(width: number): string {
	const box = theme.boxRound;
	return paint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
export function row(content: string, width: number): string {
	const box = theme.boxRound;
	const inner = Math.max(0, width - 4);
	const filled = content.length > 0 ? content : "";
	const pad = Math.max(0, inner - visibleWidth(filled));
	return `${paint(box.vertical)} ${filled}${" ".repeat(pad)} ${paint(box.vertical)}`;
}
