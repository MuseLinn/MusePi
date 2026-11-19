/**
 * Placement for the self-drawn tray menu window.
 *
 * The tray icon and the pointer disagree about where the click happened, and
 * neither source is always right: Windows supplies icon bounds but a tray on a
 * secondary display can report the primary display's column, while macOS
 * reports no bounds on the click event at all. The pointer therefore picks the
 * display, the icon rectangle anchors the horizontal centre, and a missing or
 * foreign rectangle falls back to the pointer. Same split as token-monitor's
 * `popoverBounds`.
 *
 * Pure math: the caller resolves `screen.getDisplayNearestPoint` and passes the
 * display's bounds/workArea, so the placement can be tested without Electron.
 */

function pointInside(point, area) {
	return Boolean(point && area) && point.x >= area.x && point.x < area.x + area.width && point.y >= area.y && point.y < area.y + area.height;
}

/**
 * @param {{
 *   width: number,
 *   height: number,
 *   trayBounds?: { x: number, y: number, width?: number, height?: number } | null,
 *   point?: { x: number, y: number } | null,
 *   display: { bounds: { x: number, y: number, width: number, height: number }, workArea: { x: number, y: number, width: number, height: number } },
 *   platform: string,
 * }} input
 * @returns {{ x: number, y: number }}
 */
function trayMenuPosition({ width, height, trayBounds, point, display, platform }) {
	const wa = display.workArea;
	const icon = trayBounds && trayBounds.width > 0 ? { x: trayBounds.x + trayBounds.width / 2, y: trayBounds.y } : null;
	const onDisplay = Boolean(icon) && pointInside(icon, display.bounds);
	const anchorX = onDisplay ? icon.x : (point?.x ?? wa.x + wa.width / 2);
	const anchorTop = onDisplay ? trayBounds.y + (trayBounds.height || 0) : (point?.y ?? wa.y);

	let x = Math.round(anchorX - width / 2);
	x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - width - 4));

	let y;
	if (platform === "darwin") {
		// The menu bar sits at the top of every display: drop the menu just
		// below the icon, or below the menu bar when the icon frame is gone.
		y = Math.round((onDisplay ? anchorTop : wa.y) + 4);
	} else {
		// Windows/Linux: the tray icon usually sits at the bottom, so open
		// above it and flip below when the taskbar is at the top.
		y = Math.round(anchorTop - height - 8);
		if (y < wa.y + 4) y = Math.round(anchorTop + 8);
	}
	y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - height - 4));

	return { x, y };
}

module.exports = { trayMenuPosition, pointInside };