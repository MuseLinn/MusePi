/**
 * Panel-level heterogeneous tab model (openchamber ContextPanel parity).
 *
 * Architecture note (2026-09-15 decision, supersedes the earlier "no second
 * tab row" veto — see docs/archive/gui-right-panel-redesign.md §3.3.2): the right
 * panel adopts a tab-primary model. ONE tab strip hosts every open view
 * regardless of surface (files / notes / browser / git / board …); the rail
 * becomes a launcher — selecting a rail item opens-or-focuses that surface's
 * tab instead of swapping the whole panel body. With zero tabs open the panel
 * shows an empty-state navigation page.
 *
 * Split (2026-09-29, dsh 0.2.0 two-column parity): the panel can divide into
 * TWO side-by-side columns, each with its own strip + body; tabs drag between
 * columns. The flat `tabs` array keeps ONE invariant — column 0's slice first,
 * then column 1's — so every existing consumer (close-neighbour picking,
 * newest-is-right-most fallback, per-surface budget) keeps working unchanged.
 *
 * Deliberately storage-dumb: a tab is a label plus an address. Content lives
 * with its surface (file bytes → fs, pty → daemon, note → its store), so a
 * layout restore can never resurrect stale content and agent-driven background
 * opens stay cheap.
 */

export type PanelTabSurface = string;
export type PanelColumn = 0 | 1;

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
	/** Unsaved-content marker (file editor). Runtime-only — never serialized. */
	dirty: boolean;
	/** Split-layout column. Invariant: flat `tabs` is grouped by column
	 * (all column-0 entries first, then column 1). */
	column: PanelColumn;
}

export interface PanelTabState {
	tabs: PanelTab[];
	/** Globally focused tab (last activated across both columns). */
	activeId: string | null;
	/** dsh two-column split: both columns render side by side. */
	split: boolean;
	/** Per-column displayed tab — column 1 stays null while unsplit. */
	columnActive: [string | null, string | null];
}

export const EMPTY_PANEL_TAB_STATE: PanelTabState = {
	tabs: [],
	activeId: null,
	split: false,
	columnActive: [null, null],
};

/** Column slices honour the flat-array grouping invariant. */
export function tabsInColumn(tabs: readonly PanelTab[], column: PanelColumn): PanelTab[] {
	return tabs.filter(t => t.column === column);
}

export function panelTabColumn(tabs: readonly PanelTab[], id: string): PanelColumn | null {
	return tabs.find(t => t.id === id)?.column ?? null;
}

/** Per-surface budget (openchamber CONTEXT_PANEL_MAX_TABS parity): 12 file
 *  tabs and 12 browser tabs coexist; the budget is never global. */
export const PANEL_TABS_MAX_PER_SURFACE = 12;

export const PANEL_TABS_SCHEMA_VERSION = 2;

/** Stable identity. `surface::` (empty target) is the surface's placeholder. */
export function panelTabId(descriptor: PanelTabDescriptor): string {
	if (descriptor.dedupeKey) return `${descriptor.surface}::${descriptor.dedupeKey}`;
	return `${descriptor.surface}::${descriptor.target ?? ""}`;
}

function toTab(descriptor: PanelTabDescriptor, now: number, column: PanelColumn = 0): PanelTab {
	return {
		id: panelTabId(descriptor),
		surface: descriptor.surface,
		target: descriptor.target ?? null,
		label: descriptor.label ?? descriptor.target ?? descriptor.surface,
		readOnly: descriptor.readOnly ?? false,
		touchedAt: now,
		dedupeKey: descriptor.dedupeKey ?? null,
		dirty: false,
		column,
	};
}

/**
 * A tab id that is free in `tabs`.
 *
 * Two features need "the same thing again, as a separate instance": the tab
 * menu's duplicate and a rail modifier-click. Both walk forward from `#copy2`
 * until the derived id is unused, so duplicating a copy cannot collide with
 * anything. One helper, because two copies of this walk would be two places to
 * disagree about what a copy is called.
 *
 * @param tabs - tabs the new id must not collide with.
 * @param baseId - the id being duplicated.
 * @returns the free id, and the tab fields a copy of `source` needs for it.
 */
function deriveCopyIdentity(tabs: readonly PanelTab[], baseId: string): string {
	let copyN = 2;
	let candidate = `${baseId}#copy${copyN}`;
	while (tabs.some(tab => tab.id === candidate)) {
		copyN += 1;
		candidate = `${baseId}#copy${copyN}`;
	}
	return candidate;
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

/** The column a NEW tab lands in: the focused tab's column while split
 *  (rail opens land where the user is looking), column 0 otherwise. */
function targetColumnForNewTab(state: PanelTabState): PanelColumn {
	if (!state.split || state.activeId === null) return 0;
	return panelTabColumn(state.tabs, state.activeId) ?? 0;
}

/** Pick the per-column displayed tab after a removal: the column's own
 *  right-then-left neighbour of the removed tab. `removedIdx` is the tab's
 *  index in the PRE-removal flat array. */
function resolveColumnActiveAfterClose(
	tabs: PanelTab[],
	column: PanelColumn,
	removedId: string,
	removedIdx: number,
): string | null {
	const colTabs = tabsInColumn(tabs, column);
	if (colTabs.length === 0) return null;
	// Neighbour in the pre-removal column order: same column, position after
	// removing the closed one — index within the column slice.
	const colIdx = tabsInColumn(tabs.slice(0, removedIdx + 1), column).length - 1;
	const next = colTabs[Math.min(Math.max(colIdx, 0), colTabs.length - 1)];
	return next?.id ?? null;
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
	/** Open into a specific split column (drag-into-empty-column parity).
	 *  Defaults to the focused tab's column. */
	column?: PanelColumn;
	/**
	 * Open a NEW instance instead of focusing the one this descriptor names
	 * (M1.12: rail middle-click / ⌘-click).
	 *
	 * An ordinary open is open-or-focus: a rail click on an already-open
	 * surface lands back on that tab, which is what a launcher does. The
	 * modifier-click means something else — "another one of these" — and for
	 * surfaces whose instance address is the surface itself there is no address
	 * to differ by, so the new instance has to derive its identity the same way
	 * a duplicate does. Without this the two would also collide on upsert.
	 */
	forceNew?: boolean;
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
	let column = options?.column ?? targetColumnForNewTab(state);
	let next = toTab(descriptor, now, column);

	// A real instance replaces its surface's placeholder: the rail opens
	// "Files" with no target to show the empty editor; the first actual file
	// takes that slot instead of piling up next to it. Exception — "files":
	// the placeholder IS the tree browser (dsh file-tree parity, user
	// 2026-09-29), a real instance opens as its OWN tab next to it, so the
	// tree stays one click away instead of being consumed.
	const base =
		next.target !== null && next.dedupeKey === null && next.surface !== "files"
			? state.tabs.filter(tab => !(tab.surface === next.surface && tab.target === null))
			: state.tabs;

	// forceNew: the descriptor named an instance that already exists and the
	// caller means "another one". Its id cannot be reused or the open below would
	// land on the existing tab, so it derives a fresh identity the way a
	// duplicate does — same surface, same target, independent instance. It also
	// joins the SOURCE's column rather than the focused tab's: "another one of
	// these" belongs beside the one it copies, and under split those can differ.
	let insertAfter: number | null = null;
	if (options?.forceNew === true) {
		const sourceIndex = state.tabs.findIndex(tab => tab.id === panelTabId(descriptor));
		if (sourceIndex !== -1) {
			const source = state.tabs[sourceIndex]!;
			const candidateId = deriveCopyIdentity(state.tabs, source.id);
			next = { ...source, id: candidateId, dedupeKey: candidateId, touchedAt: now };
			column = source.column;
			// Insert within the column's slice rather than at the end of the flat
			// array: that array is column-grouped, and appending across the
			// boundary would put a column-0 tab behind a column-1 one.
			let last = sourceIndex;
			while (last + 1 < state.tabs.length && state.tabs[last + 1]!.column === source.column) last += 1;
			insertAfter = last;
		}
	}

	const existing = base.find(tab => tab.id === next.id);
	const added = existing
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
		: insertAfter === null
			? [...base, next]
			: [...base.slice(0, insertAfter + 1), next, ...base.slice(insertAfter + 1)];

	const clamped = clampPanelTabs(added, maxPerSurface, reveal ? next.id : state.activeId);
	const activeId = reveal ? next.id : (state.activeId ?? next.id);
	const resolvedActive = resolveActivePanelTabId(clamped, activeId);
	const columnActive: [string | null, string | null] = reveal
		? [column === 0 ? resolvedActive : state.columnActive[0], column === 1 ? resolvedActive : state.columnActive[1]]
		: [state.columnActive[0], state.columnActive[1]];
	// A brand-new tab in a column with nothing displayed becomes that
	// column's display (background registration to an empty column still
	// leaves the column showing something sensible on split).
	if (!existing && !reveal && columnActive[column] === null && clamped.some(t => t.id === next.id)) {
		columnActive[column] = next.id;
	}

	return { ...state, tabs: clamped, activeId: resolvedActive, columnActive };
}

/** Close by id, activating the right neighbour first, then the left — the same
 *  contract as the per-surface strip, so both tab shapes behave identically.
 *  Per-column display falls back within its own column. */
export function closePanelTab(state: PanelTabState, id: string): PanelTabState {
	const idx = state.tabs.findIndex(tab => tab.id === id);
	if (idx === -1) return state;
	const tabs = state.tabs.filter(tab => tab.id !== id);
	const activeId = state.activeId !== id ? state.activeId : (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null);
	const columnActive: [string | null, string | null] = [
		state.columnActive[0] === id ? resolveColumnActiveAfterClose(tabs, 0, id, idx) : state.columnActive[0],
		state.columnActive[1] === id ? resolveColumnActiveAfterClose(tabs, 1, id, idx) : state.columnActive[1],
	];
	// Closing the active tab resolves against the flat array (right neighbour,
	// then left); per-column display fell back within its own column above.
	return { ...state, tabs, activeId, columnActive };
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

/**
 * Duplicate a tab: same surface, same target, an independent instance.
 *
 * Identity is the wrinkle. A tab's id is `surface::target` (plus an explicit
 * dedupeKey when the surface's instances are not 1:1 with targets), so a copy
 * with the source's identity would upsert right over it. The copy therefore
 * takes a fresh dedupeKey, which the model already supports for exactly this
 * shape — instances that share a target string but carry separate state. Two
 * tabs looking at one file is the point: independent scroll, independent dirty
 * buffer, one staying put while the other moves.
 *
 * The copy lands next to its source in the same column and takes focus, the
 * same reveal contract a rail open follows. `copyN` walks forward until the
 * derived id is free, so duplicating a copy cannot collide with either.
 *
 * Reference-stable on unknown id.
 */
export function duplicatePanelTab(state: PanelTabState, id: string, now = Date.now()): PanelTabState {
	const source = state.tabs.find(tab => tab.id === id);
	if (!source) return state;

	const column = source.column;
	const candidateId = deriveCopyIdentity(state.tabs, source.id);

	const copy: PanelTab = {
		id: candidateId,
		surface: source.surface,
		target: source.target,
		label: source.label,
		readOnly: source.readOnly,
		touchedAt: now,
		dedupeKey: candidateId,
		dirty: false,
		column,
	};

	// Insert directly after the source within its column slice, so the copy
	// reads as "another one of these" rather than landing at the strip's end.
	const srcIdx = state.tabs.findIndex(tab => tab.id === id);
	const tabs = [...state.tabs.slice(0, srcIdx + 1), copy, ...state.tabs.slice(srcIdx + 1)];
	const clamped = clampPanelTabs(tabs, PANEL_TABS_MAX_PER_SURFACE, copy.id);
	const resolvedActive = resolveActivePanelTabId(clamped, copy.id);
	const columnActive: [string | null, string | null] = [state.columnActive[0], state.columnActive[1]];
	columnActive[column] = copy.id;
	return { ...state, tabs: clamped, activeId: resolvedActive, columnActive };
}

/** Mark a tab's unsaved-content state. Reference-stable when the value is
 *  unchanged — the file editor re-reports dirty on every parent render, so
 *  a fresh array here would loop the re-render it reports from. */
export function setPanelTabDirty(state: PanelTabState, id: string, dirty: boolean): PanelTabState {
	const tab = state.tabs.find(t => t.id === id);
	if (!tab || tab.dirty === dirty) return state;
	return { ...state, tabs: state.tabs.map(t => (t.id === id ? { ...t, dirty } : t)) };
}

/** Focus a tab: global active + its column's display. Reference-stable on
 *  unknown id / no-op focus. */
export function activatePanelTab(state: PanelTabState, id: string): PanelTabState {
	const tab = state.tabs.find(t => t.id === id);
	if (!tab) return state;
	if (state.activeId === id && state.columnActive[tab.column] === id) return state;
	const columnActive: [string | null, string | null] = [state.columnActive[0], state.columnActive[1]];
	columnActive[tab.column] = id;
	return { ...state, activeId: id, columnActive };
}

/** Drag reorder. Both ids must live in the SAME column (the flat array is
 *  column-grouped, so a plain arrayMove stays inside the slice); a
 *  cross-column pair is a no-op — the caller routes it to
 *  {@link movePanelTabToColumn} instead. Reference-stable when either id is
 *  unknown, equal, or cross-column. */
export function reorderPanelTabs(tabs: PanelTab[], fromId: string, toId: string): PanelTab[] {
	const from = tabs.findIndex(tab => tab.id === fromId);
	const to = tabs.findIndex(tab => tab.id === toId);
	if (from === -1 || to === -1 || from === to) return tabs;
	if (tabs[from]!.column !== tabs[to]!.column) return tabs;
	const next = [...tabs];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved!);
	return next;
}

/** Move a tab into another split column (cross-column drag). The tab joins
 *  the END of the target column's slice; the moved tab becomes that column's
 *  display + the global focus. Reference-stable when the tab is unknown or
 *  already in the target column. */
export function movePanelTabToColumn(state: PanelTabState, id: string, column: PanelColumn): PanelTabState {
	const tab = state.tabs.find(t => t.id === id);
	if (!tab || tab.column === column) return state;
	const rest = state.tabs.filter(t => t.id !== id);
	const moved: PanelTab = { ...tab, column };
	// Grouping invariant: rebuild as column-0 slice + column-1 slice.
	const col0 = rest.filter(t => t.column === 0);
	const col1 = rest.filter(t => t.column === 1);
	const tabs = column === 0 ? [...col0, moved, ...col1] : [...col0, ...col1, moved];
	const columnActive: [string | null, string | null] = [state.columnActive[0], state.columnActive[1]];
	columnActive[column] = id;
	const prevColumn = tab.column;
	const prevDisplay = state.columnActive[prevColumn];
	// The moved tab is where the user is looking: it takes the global focus
	// too (activatePanelTab's invariant — the global active is always the
	// displayed tab of its own column; the browser singleton guard keys on
	// activeId to pick its hosting column).
	const activeId = id;
	return {
		...state,
		tabs,
		activeId,
		columnActive:
			prevDisplay === id
				? ([
						prevColumn === 0 ? resolveColumnActiveAfterClose(rest, 0, id, rest.length) : columnActive[0],
						prevColumn === 1 ? resolveColumnActiveAfterClose(rest, 1, id, rest.length) : columnActive[1],
					] as [string | null, string | null])
				: columnActive,
	};
}

/** Toggle the two-column split. Disabling MERGES: every column-1 tab moves
 *  into column 0 preserving order; per-column display collapses to the
 *  primary. Enabling never moves tabs — column 1 starts empty. */
export function setPanelSplit(state: PanelTabState, split: boolean): PanelTabState {
	if (state.split === split) return state;
	if (split) return { ...state, split: true };
	const tabs = state.tabs.map(t => (t.column === 1 ? { ...t, column: 0 as PanelColumn } : t));
	const activeId = state.activeId ?? resolveActivePanelTabId(tabs, null);
	return { ...state, tabs, split: false, columnActive: [activeId, null] };
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
	column: PanelColumn;
}

interface SerializedPanelTabsV2 {
	v: 2;
	split: boolean;
	tabs: SerializedPanelTab[];
	activeId: string | null;
	columnActive: [string | null, string | null];
}

/** v1 (pre-split) payload — restored by migration, never written again. */
interface SerializedPanelTabsV1 {
	v: 1;
	tabs: Array<Omit<SerializedPanelTab, "column">>;
	activeId: string | null;
}

export function serializePanelTabs(state: PanelTabState): SerializedPanelTabsV2 {
	return {
		v: PANEL_TABS_SCHEMA_VERSION,
		split: state.split,
		tabs: state.tabs.map(({ surface, target, label, readOnly, touchedAt, dedupeKey, column }) => ({
			surface,
			target,
			label,
			readOnly,
			touchedAt,
			dedupeKey,
			column,
		})),
		activeId: state.activeId,
		columnActive: [state.columnActive[0], state.columnActive[1]],
	};
}

function validSerializedTab(t: unknown): t is SerializedPanelTab {
	const row = t as Partial<SerializedPanelTab> | null;
	return (
		typeof row === "object" &&
		row !== null &&
		typeof row.surface === "string" &&
		row.surface.length > 0 &&
		(row.target === null || typeof row.target === "string") &&
		(row.column === 0 || row.column === 1)
	);
}

/** Ids are re-derived on restore so a rule change cannot strand stale ids.
 *  v1 payloads migrate (everything was column 0 pre-split); unknown schema
 *  versions and malformed rows are dropped, not guessed at: a lost tab layout
 *  costs one reopen, a misread one costs trust. */
export function restorePanelTabs(raw: unknown): PanelTabState {
	if (typeof raw !== "object" || raw === null) return { ...EMPTY_PANEL_TAB_STATE };
	const r = raw as Partial<SerializedPanelTabsV2> & Partial<SerializedPanelTabsV1>;
	if (r.v === 1) {
		const tabsV1: SerializedPanelTabsV1["tabs"] = Array.isArray(r.tabs)
			? (r.tabs as SerializedPanelTabsV1["tabs"])
			: [];
		const tabs: PanelTab[] = tabsV1
			.filter(
				(t): t is SerializedPanelTabsV1["tabs"][number] =>
					typeof t?.surface === "string" &&
					t.surface.length > 0 &&
					(t.target === null || typeof t.target === "string"),
			)
			.map(t =>
				toTab(
					{ surface: t.surface, target: t.target, label: t.label, readOnly: t.readOnly, dedupeKey: t.dedupeKey },
					t.touchedAt,
					0,
				),
			);
		const activeId = typeof r.activeId === "string" && tabs.some(tab => tab.id === r.activeId) ? r.activeId : null;
		const resolved = resolveActivePanelTabId(tabs, activeId);
		return { tabs, activeId: resolved, split: false, columnActive: [resolved, null] };
	}
	if (r.v !== PANEL_TABS_SCHEMA_VERSION) return { ...EMPTY_PANEL_TAB_STATE };
	const tabs: PanelTab[] = (Array.isArray(r.tabs) ? r.tabs : [])
		.filter(validSerializedTab)
		.map(t =>
			toTab(
				{ surface: t.surface, target: t.target, label: t.label, readOnly: t.readOnly, dedupeKey: t.dedupeKey },
				t.touchedAt,
				t.column,
			),
		);
	// Re-assert the grouping invariant in case a hand-edited payload interleaved.
	const grouped = [...tabsInColumn(tabs, 0), ...tabsInColumn(tabs, 1)];
	const ca = Array.isArray(r.columnActive) ? r.columnActive : [];
	const columnActive: [string | null, string | null] = [
		typeof ca[0] === "string" && grouped.some(t => t.column === 0 && t.id === ca[0]) ? ca[0] : null,
		typeof ca[1] === "string" && grouped.some(t => t.column === 1 && t.id === ca[1]) ? ca[1] : null,
	];
	for (const col of [0, 1] as const) {
		if (columnActive[col] === null) {
			const fallback = tabsInColumn(grouped, col);
			if (fallback.length > 0) columnActive[col] = fallback[fallback.length - 1]!.id;
		}
	}
	const activeId =
		typeof r.activeId === "string" && grouped.some(tab => tab.id === r.activeId)
			? r.activeId
			: (columnActive[1] ?? columnActive[0]);
	return {
		tabs: grouped,
		activeId: resolveActivePanelTabId(grouped, activeId),
		split: r.split === true,
		columnActive,
	};
}
