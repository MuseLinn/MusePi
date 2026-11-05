import type { ManagedTab } from "./managed-browser-host";
import {
	closePanelTab,
	type PanelTab,
	type PanelTabDescriptor,
	type PanelTabState,
	upsertPanelTab,
} from "./panel-tabs";

export function browserPanelDescriptor(tab: ManagedTab, fallbackLabel: string): PanelTabDescriptor {
	return {
		surface: "browser",
		target: tab.id,
		dedupeKey: tab.id,
		label: tab.customTitle ?? (tab.blank || !tab.title ? fallbackLabel : tab.title),
	};
}

export function browserTarget(panelTab: PanelTab): string | null {
	return panelTab.surface === "browser" ? panelTab.target : null;
}

export function reconcileBrowserPanelTabs(
	state: PanelTabState,
	tabs: readonly ManagedTab[],
	fallbackLabel: string,
): PanelTabState {
	const managedById = new Map(tabs.map(tab => [tab.id, tab]));
	let next = state;

	for (const panelTab of state.tabs) {
		const target = browserTarget(panelTab);
		if (panelTab.surface === "browser" && (target === null || !managedById.has(target))) {
			next = closePanelTab(next, panelTab.id);
		}
	}

	let labelsChanged = false;
	const projected = next.tabs.map(panelTab => {
		const target = browserTarget(panelTab);
		if (target === null) return panelTab;
		const managed = managedById.get(target);
		if (!managed) return panelTab;
		const label = browserPanelDescriptor(managed, fallbackLabel).label ?? fallbackLabel;
		if (panelTab.label === label) return panelTab;
		labelsChanged = true;
		return { ...panelTab, label };
	});
	if (labelsChanged) next = { ...next, tabs: projected };

	const projectedIds = new Set(next.tabs.map(panelTab => browserTarget(panelTab)).filter(target => target !== null));
	for (const managed of tabs) {
		if (projectedIds.has(managed.id)) continue;
		next = upsertPanelTab(next, browserPanelDescriptor(managed, fallbackLabel), {
			reveal: false,
			now: managed.lastActivityAt,
			maxPerSurface: Number.POSITIVE_INFINITY,
		});
		projectedIds.add(managed.id);
	}

	return next;
}
