/**
 * Right-panel width budget.
 *
 * The drag used to clamp only to [260, 1200] regardless of the window, so the
 * chat column could be squeezed to nothing — messages reflow to one word per
 * line and the composer's action row has nowhere to go. The panel therefore
 * stops growing while the chat column still keeps `MIN_CHAT_WIDTH`.
 */
export const MIN_PANEL_WIDTH = 260;
export const MAX_PANEL_WIDTH = 1200;

/** The chat column never shrinks below this (readable messages + a usable composer). */
export const MIN_CHAT_WIDTH = 420;

/**
 * Largest panel width that still leaves `minChat` for the chat column.
 *
 * @param panelRight the panel's right edge (window chrome minus the rail)
 * @param chatLeft   the chat column's left edge (sidebar + insets)
 */
export function maxPanelWidth(
	panelRight: number,
	chatLeft: number,
	minChat: number = MIN_CHAT_WIDTH,
	absoluteMax: number = MAX_PANEL_WIDTH,
): number {
	if (!Number.isFinite(panelRight) || !Number.isFinite(chatLeft)) return absoluteMax;
	const budget = panelRight - chatLeft - minChat;
	return Math.max(MIN_PANEL_WIDTH, Math.min(absoluteMax, budget));
}
