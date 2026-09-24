/**
 * Settings-shell slot-replacement contract (2026-09-24).
 *
 * The settings shell reuses the main layout instead of overlaying the chat
 * column: while it is active, the settings NAV fills the app sidebar's slot
 * (`.gui-settings-nav-slot`, SettingsView portals into it) and the settings
 * content fills the chat column. The real sidebar and the chat header +
 * surface stay MOUNTED underneath, only display:none — closing restores the
 * workspace (expanded groups, transcript, virtual list) without a re-mount.
 *
 * This function is the single decision point app.tsx renders from; the test
 * in test/settings-shell.test.tsx pins the table:
 *
 *   closed                 → workspace visible, no slot
 *   open                   → slot mounted, sidebar + chat keepers hidden
 *   open + leavingSettings → same, nav slot flagged for its blur-out
 *   closed (after leave)   → identical to closed (keepers reveal, slot gone)
 */

export interface SettingsShellState {
	/** True while the settings shell occupies the slots (open OR leaving). */
	settingsActive: boolean;
	/** Render the portal-target div in the sidebar slot. */
	navSlotMounted: boolean;
	/** Nav slot plays the 150ms blur-out (close transition window). */
	navSlotLeaving: boolean;
	/** Sidebar keeper display:none (session list state preserved). */
	sideKeeperHidden: boolean;
	/** Chat-column keeper display:none (transcript state preserved). */
	chatColKeeperHidden: boolean;
}

export function computeSettingsShellState(state: {
	settingsOpen: boolean;
	leavingSettings: boolean;
}): SettingsShellState {
	const settingsActive = state.settingsOpen || state.leavingSettings;
	return {
		settingsActive,
		navSlotMounted: settingsActive,
		navSlotLeaving: state.leavingSettings,
		sideKeeperHidden: settingsActive,
		chatColKeeperHidden: settingsActive,
	};
}
