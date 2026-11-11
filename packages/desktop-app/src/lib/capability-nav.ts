/**
 * Capability-center second-tier panel bridge (2026-11-08).
 *
 * The rail owns the panel and the `app.capability` slot owns the page: two
 * independent React subtrees. The page publishes ONE projection of its state
 * (active tab + the two counts it already loads); the panel renders that
 * projection and sends actions back. Neither subtree imports the other, and
 * a slot mount passes no geometry props.
 *
 * This module is registered in EXTENSION_HOST_MODULES (`capability-nav`), so
 * the compiled `app.capability` page and the compiled `sidebar.panel.capability`
 * panel share ONE store instead of bundling private copies.
 */

/** The three capability destinations. Single source for page + panel. */
export type CapabilityTab = "skills" | "plugins" | "marketplace";

export interface CapabilityNavSnapshot {
	/** Active destination tab; drives the panel's single selected row. */
	tab: CapabilityTab;
	/** 「我安装的 N」 count, already loaded by the page for its sub-tab label. */
	skillsCount: number;
	/** plugins.packages length, already loaded by the page for its list. */
	pluginsCount: number;
}

export type CapabilityNavAction =
	| { type: "select"; tab: CapabilityTab }
	/** The panel's full-width primary action: jump to the marketplace. */
	| { type: "add" };

const EMPTY: CapabilityNavSnapshot = { tab: "skills", skillsCount: 0, pluginsCount: 0 };
let snapshot: CapabilityNavSnapshot = EMPTY;
const stateListeners = new Set<() => void>();
const actionListeners = new Set<(action: CapabilityNavAction) => void>();
/**
 * An action emitted while the page is not mounted. Hover-peek renders the
 * panel beside a different destination, and the destination swap mounts the
 * page ~150ms later; retaining the last action lets the row click that
 * committed the swap still land on the tab it named. Last write wins.
 */
let pendingAction: CapabilityNavAction | null = null;

export function publishCapabilityNav(next: CapabilityNavSnapshot): void {
	snapshot = next;
	for (const listener of stateListeners) listener();
}

export function readCapabilityNav(): CapabilityNavSnapshot {
	return snapshot;
}

export function subscribeCapabilityNav(listener: () => void): () => void {
	stateListeners.add(listener);
	return () => stateListeners.delete(listener);
}

export function emitCapabilityNavAction(action: CapabilityNavAction): void {
	if (actionListeners.size === 0) {
		pendingAction = action;
		return;
	}
	pendingAction = null;
	for (const listener of actionListeners) listener(action);
}

export function subscribeCapabilityNavAction(listener: (action: CapabilityNavAction) => void): () => void {
	actionListeners.add(listener);
	const pending = pendingAction;
	if (pending) {
		pendingAction = null;
		listener(pending);
	}
	return () => actionListeners.delete(listener);
}

/** Reset on page unmount so the next visit cannot flash stale counts. */
export function clearCapabilityNav(): void {
	publishCapabilityNav(EMPTY);
}
