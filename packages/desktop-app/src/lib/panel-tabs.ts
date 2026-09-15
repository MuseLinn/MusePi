/**
 * Panel-level heterogeneous tab model (openchamber ContextPanel parity).
 *
 * Architecture note (2026-09-15 decision, supersedes the earlier "no second
 * tab row" veto — see docs/gui-right-panel-redesign.md §3.3.2): the right
 * panel adopts a tab-primary model. ONE tab strip hosts every open view
 * regardless of surface (files / notes / browser / git / board …); the rail
 * becomes a launcher — selecting a rail item opens-or-focuses that surface's
 * tab instead of swapping the whole panel body. With zero tabs open the panel
 * shows an empty-state navigation page.
 *
 * Deliberately storage-dumb: a tab is a label plus an address. Content lives
 * with its surface (file bytes → fs, pty → daemon, note → its store), so a
 * layout restore can never resurrect stale content and agent-driven background
 * opens stay cheap.
 */

export type PanelTabSurface = string;

export interface PanelTabDescriptor {
	/** Which surface renders this tab (surfaces/registry.ts id). */
	surface: PanelTabSurface;
	/**
	 * Instance address inside the surface: file path, URL, note id… `null`
	 * marks the surface's placeholder tab (rail can open "Files" before any
	 * file is picked — a real open then replaces the placeholder).
	 */
	target?: string | null;
	label?: string | null;
	/**
	 * Explicit identity override for surfaces whose instances are not 1:1 with
	 * a target string (chat sessions by session id, diff by staged flag…).
	 */
	dedupeKey?: string | null;
	readOnly?: boolean;
}

export interface PanelTab {
	readonly id: string;
	surface: PanelTabSurface;
	target: string | null;
	label: string;
	readOnly: boolean;
	/** Recency stamp — the eviction budget spends the oldest non-active tabs. */
	touchedAt: number;
	/** Preserved so a restored layout can re-derive ids after rule changes. */
	dedupeKey: string | null;
}

export interface PanelTabState {
	tabs: PanelTab[];
	activeId: string | null;
}

/** Per-surface budget (openchamber CONTEXT_PANEL_MAX_TABS parity): 12 file
 *  tabs and 12 browser tabs coexist; the budget is never global. */
export const PANEL_TABS_MAX_PER_SURFACE = 12;

export const PANEL_TABS_SCHEMA_VERSION = 1;

/** Stable identity. `surface::` (empty target) is the surface's placeholder. */
export function panelTabId(descriptor: PanelTabDescriptor): string {
	if (descriptor.dedupeKey) return `${descriptor.surface}::${descriptor.dedupeKey}`;
	return `${descriptor.surface}::${descriptor.target ?? ""}`;
}

function toTab(descriptor: PanelTabDescriptor, now: number): PanelTab {
	return {
		id: panelTabId(descriptor),
		surface: descriptor.surface,
		target: descriptor.target ?? null,
		label: descriptor.label ?? descriptor.target ?? descriptor.surface,
		readOnly: descriptor.readOnly ?? false,
		touchedAt: now,
		dedupeKey: descriptor.dedupeKey ?? null,
	};
}

/** Keep the budget per surface, spending the oldest non-active tabs first.
 *  If eviction would have to touch the active tab, keep one over budget —
 *  losing the tab in use is worse than exceeding a soft limit. */
export function clampPanelTabs(tabs: PanelTab[], maxPerSurface: number, activeId: string | null): PanelTab[] {
	const counts = new Map<string, number>();
	for (const tab of tabs) counts.set(tab.surface, (counts.get(tab.surface) ?? 0) + 1);
	const over = [...counts.entries()].filter(([, count]) => count > maxPerSurface);
	if (over.length === 0) return tabs;

	const remove = new Set<string>();
	for (const [surface, count] of over) {
		const removable = tabs
			.filter(tab => tab.surface === surface)
			.sort((a, b) => a.touchedAt - b.touchedAt)
			.filter(tab => tab.id !== activeId);
		for (const tab of removable.slice(0, count - maxPerSurface)) remove.add(tab.id);
	}
	return remove.size === 0 ? tabs : tabs.filter(tab => !remove.has(tab.id));
}

/** Active id survives unless the tab is gone; an empty strip has none, and a
 *  non-empty strip falls back to the newest entry (right-most = most recent). */
export function resolveActivePanelTabId(tabs: PanelTab[], activeId: string | null): string | null {
	if (activeId && tabs.some(tab => tab.id === activeId)) return activeId;
	return tabs.length > 0 ? tabs[tabs.length - 1].id : null;
}

export interface UpsertPanelTabOptions {
	/**
	 * `true` (default): focus the tab and mark the panel open-worthy.
	 * `false`: background registration — an agent opened a page behind the
	 * user's back, so whatever they were looking at stays on screen and the
	 * tab simply exists (kept mounted) for later manual focus.
	 */
	reveal?: boolean;
	maxPerSurface?: number;
	/** Injectable for tests; defaults to Date.now(). */
	now?: number;
}

export function upsertPanelTab(
	state: PanelTabState,
	descriptor: PanelTabDescriptor,
	options?: UpsertPanelTabOptions,
): PanelTabState {
	const reveal = options?.reveal !== false;
	const maxPerSurface = options?.maxPerSurface ?? PANEL_TABS_MAX_PER_SURFACE;
	const now = options?.now ?? Date.now();
	const next = toTab(descriptor, now);

	// A real instance replaces its surface's placeholder: the rail opens
	// "Files" with no target to show the empty editor; the first actual file
	// takes that slot instead of piling up next to it.
	const base =
		next.target !== null && next.dedupeKey === null
			? state.tabs.filter(tab => !(tab.surface === next.surface && tab.target === null))
			: state.tabs;

	const existing = base.find(tab => tab.id === next.id);
	const tabs = existing
		? base.map(tab =>
				tab.id === next.id
					? {
							...tab,
							target: next.target ?? tab.target,
							label: next.label ?? tab.label,
							readOnly: next.readOnly,
							touchedAt: now,
						}
					: tab,
			)
		: [...base, next];

	const clamped = clampPanelTabs(tabs, maxPerSurface, reveal ? next.id : state.activeId);
	const activeId = reveal ? next.id : (state.activeId ?? next.id);

	return { tabs: clamped, activeId: resolveActivePanelTabId(clamped, activeId) };
}

/** Close by id, activating the right neighbour first, then the left — the same
 *  contract as the per-surface strip, so both tab shapes behave identically. */
export function closePanelTab(state: PanelTabState, id: string): PanelTabState {
	const idx = state.tabs.findIndex(tab => tab.id === id);
	if (idx === -1) return state;
	const tabs = state.tabs.filter(tab => tab.id !== id);
	if (state.activeId !== id) return { tabs, activeId: state.activeId };
	const neighbour = tabs[Math.min(idx, tabs.length - 1)];
	return { tabs, activeId: neighbour?.id ?? null };
}

export function closePanelTabs(state: PanelTabState, ids: readonly string[]): PanelTabState {
	let current = state;
	for (const id of ids) {
		const after = closePanelTab(current, id);
		// A miss must not reset the active tab mid-batch.
		current = after === current ? current : after;
	}
	return current;
}

/** Drag reorder. Reference-stable when either id is unknown or equal. */
export function reorderPanelTabs(tabs: PanelTab[], fromId: string, toId: string): PanelTab[] {
	const from = tabs.findIndex(tab => tab.id === fromId);
	const to = tabs.findIndex(tab => tab.id === toId);
	if (from === -1 || to === -1 || from === to) return tabs;
	const next = [...tabs];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved!);
	return next;
}

/* ------------------------------------------------------------------ */
/* Persistence (labels + addresses only, never content)                */
/* ------------------------------------------------------------------ */

interface SerializedPanelTab {
	surface: string;
	target: string | null;
	label: string;
	readOnly: boolean;
	touchedAt: number;
	dedupeKey: string | null;
}

interface SerializedPanelTabs {
	v: number;
	tabs: SerializedPanelTab[];
	activeId: string | null;
}

export function serializePanelTabs(state: PanelTabState): SerializedPanelTabs {
	return {
		v: PANEL_TABS_SCHEMA_VERSION,
		tabs: state.tabs.map(({ surface, target, label, readOnly, touchedAt, dedupeKey }) => ({
			surface,
			target,
			label,
			readOnly,
			touchedAt,
			dedupeKey,
		})),
		activeId: state.activeId,
	};
}

/** Ids are re-derived on restore so a rule change cannot strand stale ids.
 *  Unknown schema versions and malformed rows are dropped, not guessed at:
 *  a lost tab layout costs one reopen, a misread one costs trust. */
export function restorePanelTabs(raw: unknown): PanelTabState {
	if (typeof raw !== "object" || raw === null) return { tabs: [], activeId: null };
	const r = raw as Partial<SerializedPanelTabs>;
	if (r.v !== PANEL_TABS_SCHEMA_VERSION) return { tabs: [], activeId: null };
	const tabs: PanelTab[] = (r.tabs ?? [])
		.filter(
			(t): t is SerializedPanelTab =>
				typeof t?.surface === "string" &&
				t.surface.length > 0 &&
				(t.target === null || typeof t.target === "string"),
		)
		.map(t => {
			const tab = toTab(
				{ surface: t.surface, target: t.target, label: t.label, readOnly: t.readOnly, dedupeKey: t.dedupeKey },
				t.touchedAt,
			);
			return tab;
		});
	const activeId = typeof r.activeId === "string" && tabs.some(tab => tab.id === r.activeId) ? r.activeId : null;
	return { tabs, activeId: resolveActivePanelTabId(tabs, activeId) };
}
