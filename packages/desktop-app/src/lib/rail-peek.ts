/**
 * When the docked left panel may be shown as a hover-peek floating surface.
 *
 * Pure decision so the layout states are contract-tested without mounting
 * Electron: the peek is a companion to a CLOSED docked panel, on a
 * destination that actually HAS a left panel. A page destination (board / PR
 * / capability) owns the whole surface, settings owns the nav slot, and the
 * narrow-window drawer replaces both. Each of those would otherwise float a
 * session list over content it does not belong to.
 */
export function railPeekEligible(state: {
	sideCollapsed: boolean;
	pageDestinationActive: boolean;
	settingsActive: boolean;
	narrowSidebarOpen: boolean;
}): boolean {
	return state.sideCollapsed && !state.pageDestinationActive && !state.settingsActive && !state.narrowSidebarOpen;
}
