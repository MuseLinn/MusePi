/**
 * Which second-tier panel occupies the sidebar slot, and when it may float.
 *
 * Pure decisions so the layout states are contract-tested without mounting
 * Electron (2026-11-08). The rail is a DESTINATION column, not a panel:
 * hovering its empty band or an action button must not float the 首页 session
 * list. A peek starts on one rail button that declares `panelId`, and the
 * host floats the panel with that id — 任务中心 therefore peeks its own task
 * list, 能力中心 its own capability navigation, instead of the session list.
 *
 * `data-panel` on `.gui-side-keeper` is the single CSS authority for which
 * mounted pane is visible; `data-peek` only adds the floating geometry.
 */

export type SidebarPanelId = "home" | "scheduled" | "capability";

export function railPeekEligible(state: {
	sideCollapsed: boolean;
	settingsActive: boolean;
	narrowSidebarOpen: boolean;
}): boolean {
	// A page destination is NOT excluded: its rail button owns a panel too.
	return state.sideCollapsed && !state.settingsActive && !state.narrowSidebarOpen;
}

export function isSidebarPanelId(value: string | null): value is SidebarPanelId {
	return value === "home" || value === "scheduled" || value === "capability";
}

/**
 * Resolve the pane visible in the docked (or floating) sidebar slot.
 * `null` means every mounted pane stays hidden — a folded panel with no
 * hover, a destination without a panel, or the settings nav slot in charge.
 */
export function resolveSidebarPanel(state: {
	settingsActive: boolean;
	sideCollapsed: boolean;
	/** Panel id reported by the hovered rail button, or null. */
	peekPanel: string | null;
	scheduledActive: boolean;
	/** Capability center owns its own panel (2026-11-08). */
	capabilityActive?: boolean;
	pageDestinationActive: boolean;
}): SidebarPanelId | null {
	if (state.settingsActive) return null;
	// Folded: only a hovered panel may appear, and only the one that owns the
	// hovered destination. No hover → no panel (the old bug floated 首页).
	if (state.sideCollapsed) return isSidebarPanelId(state.peekPanel) ? state.peekPanel : null;
	if (state.scheduledActive) return "scheduled";
	if (state.capabilityActive === true) return "capability";
	if (state.pageDestinationActive) return null;
	return "home";
}
