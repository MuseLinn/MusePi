import { MIN_CHAT_WIDTH, MIN_PANEL_WIDTH } from "./panel-width";

/** Left icon rail. */
const RAIL_W = 52;
/** Right panel's icon rail (the panel itself folds to zero width). */
const PANEL_RAIL_W = 44;
/** Card gutters between the rails and the session card (both sides). */
const GUTTERS = 24;

/**
 * Viewport width below which the sidebar becomes an overlay drawer.
 *
 * The drawer threshold is NOT a fixed window breakpoint: a docked sidebar
 * plus a docked panel could squeeze the session column below the width it
 * needs to stay readable while the window itself was still "wide". Reserving
 * the session minimum (and the panel minimum when the panel is docked) means
 * the sidebar folds exactly when its slot would steal that width.
 */
export function sidebarDrawerThreshold(sideWidth: number, panelOpen: boolean): number {
	return RAIL_W + sideWidth + MIN_CHAT_WIDTH + PANEL_RAIL_W + GUTTERS + (panelOpen ? MIN_PANEL_WIDTH : 0);
}
