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

/** The chat column never shrinks below this (readable messages + a usable
 *  composer). 320 keeps a message column readable and still fits the
 *  composer once the model capsule shrinks its label instead of wrapping. */
export const MIN_CHAT_WIDTH = 320;

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

/** Card gutter each workspace card carries on both sides (gui-chat.css
 *  `--gui-card-gutter`). The panel's row footprint is its card plus these. */
export const PANEL_CARD_GUTTER_PX = 8;

/**
 * What the right panel currently takes from the shared workspace row.
 *
 * The docked panel is a flex item, so its width is the row's, and anything
 * else that wants a column beside it has to budget for it. The session info
 * card cannot measure the panel: the panel is its own subtree with its own
 * drag state, and reading a rect during the card's render would make the seat
 * follow a resize frame by frame. `ContextPanel` publishes the width it
 * renders with instead — the user's setting, not a layout output, so the
 * answer is stable and already final in the commit that opens the panel.
 */
export interface PanelOccupancy {
	open: boolean;
	maximized: boolean;
	width: number;
}

const PANEL_CLOSED: PanelOccupancy = { open: false, maximized: false, width: 0 };

let panelOccupancy: PanelOccupancy = PANEL_CLOSED;
const panelOccupancyListeners = new Set<() => void>();

export function setPanelOccupancy(next: PanelOccupancy): void {
	const current = panelOccupancy;
	if (current.open === next.open && current.maximized === next.maximized && current.width === next.width) return;
	panelOccupancy = next;
	for (const listener of panelOccupancyListeners) listener();
}

export function subscribePanelOccupancy(listener: () => void): () => void {
	panelOccupancyListeners.add(listener);
	return () => panelOccupancyListeners.delete(listener);
}

export function getPanelOccupancy(): PanelOccupancy {
	return panelOccupancy;
}

/**
 * Row width the open panel spends: its card plus both gutters. A folded panel
 * spends nothing, and a maximized one spends nothing either — it is a fixed
 * overlay over the chat column, not a flex sibling.
 */
export function panelRowWidth(occupancy: PanelOccupancy = panelOccupancy): number {
	if (!occupancy.open || occupancy.maximized) return 0;
	return Math.max(0, Math.round(occupancy.width)) + PANEL_CARD_GUTTER_PX * 2;
}
