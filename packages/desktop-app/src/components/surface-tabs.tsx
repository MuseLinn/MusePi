/**
 * Surface-scoped multi-instance tab strip.
 *
 * Scope note (architecture boundary, see docs/gui-right-panel-redesign.md):
 * the RightRail is the single navigation axis — a panel-header tab row that
 * duplicates that role was architecturally vetoed. What this component
 * provides is the *other* tab shape: multiple live instances INSIDE one
 * surface (openchamber file/chat/browser tabs, WorkBuddy doc tabs), switching
 * content within the surface the same way GitPanel's sub-tabs do, plus
 * multi-instance + drag reorder + close.
 *
 * Deliberately NOT here: docking, pop-out, cross-panel drag, or any notion of
 * "which surface is active" — that stays in ChatView's activeView state.
 */
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

/** One open instance inside a surface. Content lives elsewhere; the strip
 *  only tracks labels, so serialization stays trivial. */
export interface SurfaceTab {
	/** Stable identity (e.g. file path, doc id). Never an array index. */
	readonly id: string;
	title: string;
	/** Unsaved-changes dot. */
	dirty?: boolean;
}

export interface SurfaceTabState {
	tabs: SurfaceTab[];
	activeId: string | null;
}

/* ------------------------------------------------------------------ */
/* Pure state helpers (exported for bun:test — no React involved).     */
/* ------------------------------------------------------------------ */

/** Move `fromId` before/after `toId` preserving everything else. No-op when
 *  either id is unknown or both are equal (reference-stable return). */
export function reorderSurfaceTabs(tabs: SurfaceTab[], fromId: string, toId: string): SurfaceTab[] {
	const from = tabs.findIndex(t => t.id === fromId);
	const to = tabs.findIndex(t => t.id === toId);
	if (from === -1 || to === -1 || from === to) return tabs;
	return arrayMove(tabs, from, to);
}

/** Close by id and pick the next active tab: right neighbour first, then
 *  left, then null. Returning the pair keeps the "who becomes active" rule
 *  in one testable place instead of smearing it across components. */
export function closeSurfaceTab(state: SurfaceTabState, id: string): SurfaceTabState {
	const idx = state.tabs.findIndex(t => t.id === id);
	if (idx === -1) return state;
	const tabs = state.tabs.filter(t => t.id !== id);
	if (state.activeId !== id) return { tabs, activeId: state.activeId };
	const next = tabs[Math.min(idx, tabs.length - 1)];
	return { tabs, activeId: next?.id ?? null };
}

const SURFACE_TABS_SCHEMA_VERSION = 1;

interface SerializedSurfaceTabs {
	v: number;
	tabs: Array<{ id: string; title: string }>;
	activeId: string | null;
}

/** Persist labels only — content belongs to each surface's own store (docs →
 *  its store, terminal → its pty, board → its model). Keeping them decoupled
 *  means a tab layout restore can never resurrect stale content. */
export function serializeSurfaceTabs(state: SurfaceTabState): SerializedSurfaceTabs {
	return {
		v: SURFACE_TABS_SCHEMA_VERSION,
		tabs: state.tabs.map(({ id, title }) => ({ id, title })),
		activeId: state.activeId,
	};
}

/** Unknown versions are dropped, not best-effort migrated: restoring a
 *  misread layout loses a reopen click, restoring a broken one loses trust. */
export function restoreSurfaceTabs(raw: unknown): SurfaceTabState {
	if (typeof raw !== "object" || raw === null) return { tabs: [], activeId: null };
	const r = raw as Partial<SerializedSurfaceTabs>;
	if (r.v !== SURFACE_TABS_SCHEMA_VERSION) return { tabs: [], activeId: null };
	const tabs = (r.tabs ?? [])
		.filter((t): t is { id: string; title: string } => typeof t?.id === "string" && typeof t?.title === "string")
		.map(({ id, title }) => ({ id, title }));
	const activeId = typeof r.activeId === "string" && tabs.some(t => t.id === r.activeId) ? r.activeId : null;
	return { tabs, activeId: activeId ?? tabs[0]?.id ?? null };
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export interface UseSurfaceTabsResult extends SurfaceTabState {
	open(id: string, title: string): void;
	close(id: string): void;
	activate(id: string): void;
	reorder(fromId: string, toId: string): void;
	rename(id: string, title: string): void;
	setDirty(id: string, dirty: boolean): void;
}

const SURFACE_TABS_KEEP_MOUNTED_LIMIT = 8;

/**
 * @param storageKey e.g. `musepi-gui-doc-tabs-${cwd}` — compose with cwd when
 *   the set of instances is per-project (terminal-tabs precedent).
 * @param onWarn keep-mounted pressure report; wire to your toast/logger.
 */
export function useSurfaceTabs(storageKey: string, onWarn?: (message: string) => void): UseSurfaceTabsResult {
	const [state, setState] = useState<SurfaceTabState>(() => {
		try {
			const raw = localStorage.getItem(storageKey);
			return raw ? restoreSurfaceTabs(JSON.parse(raw)) : { tabs: [], activeId: null };
		} catch {
			return { tabs: [], activeId: null };
		}
	});

	// Persist on every change. Labels are tiny; no debounce needed.
	useEffect(() => {
		try {
			localStorage.setItem(storageKey, JSON.stringify(serializeSurfaceTabs(state)));
		} catch {
			// Storage full / disabled — tab layout is cosmetic, never fatal.
		}
	}, [storageKey, state]);

	// All mutators are useCallback-stable: callers put them in dependency
	// arrays of their own callbacks/effects (e.g. an openPreview that an
	// artifact-open effect depends on), so an unstable identity here would
	// re-run those effects on every render.
	const open = useCallback(
		(id: string, title: string): void => {
			setState(s => {
				if (s.tabs.some(t => t.id === id)) return { ...s, activeId: id };
				const keepMounted = s.tabs.length + 1;
				if (keepMounted > SURFACE_TABS_KEEP_MOUNTED_LIMIT) {
					onWarn?.(`surface tabs over keep-mounted limit (${SURFACE_TABS_KEEP_MOUNTED_LIMIT})`);
				}
				return { tabs: [...s.tabs, { id, title }], activeId: id };
			});
		},
		[onWarn],
	);

	const close = useCallback((id: string): void => setState(s => closeSurfaceTab(s, id)), []);
	const activate = useCallback(
		(id: string): void => setState(s => (s.activeId === id ? s : { ...s, activeId: id })),
		[],
	);
	const reorder = useCallback(
		(fromId: string, toId: string): void =>
			setState(s => {
				const tabs = reorderSurfaceTabs(s.tabs, fromId, toId);
				return tabs === s.tabs ? s : { ...s, tabs };
			}),
		[],
	);
	const rename = useCallback(
		(id: string, title: string): void =>
			setState(s => ({ ...s, tabs: s.tabs.map(t => (t.id === id ? { ...t, title } : t)) })),
		[],
	);
	const setDirty = useCallback(
		(id: string, dirty: boolean): void =>
			setState(s => ({ ...s, tabs: s.tabs.map(t => (t.id === id ? { ...t, dirty } : t)) })),
		[],
	);

	return { ...state, open, close, activate, reorder, rename, setDirty };
}

/* ------------------------------------------------------------------ */
/* Strip                                                               */
/* ------------------------------------------------------------------ */

export interface SurfaceTabStripProps {
	tabs: readonly SurfaceTab[];
	activeId: string | null;
	onActivate(id: string): void;
	onClose(id: string): void;
	onReorder(fromId: string, toId: string): void;
	/** Localized "close" verb for the close button's aria-label. */
	closeLabel?: string;
	ariaLabel?: string;
}

/** Horizontal, drag-reorderable, closable tab strip (WorkBuddy doc-tabs /
 *  openchamber SortableTabsStrip parity). Scrollable when crowded; tabs flex
 *  to fill and clamp between min/max width before the scrollbar appears. */
export function SurfaceTabStrip({
	tabs,
	activeId,
	onActivate,
	onClose,
	onReorder,
	closeLabel = "close",
	ariaLabel,
}: SurfaceTabStripProps): ReactNode {
	// Same sensor tuning as RightRail's rail reorder (distance 8 keeps clicks
	// click-y; touch needs the long-press delay so scrolling still scrolls).
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
	);

	const onDragEnd = (e: DragEndEvent): void => {
		const active = String(e.active.id);
		const over = e.over ? String(e.over.id) : null;
		if (!over || active === over) return;
		onReorder(active, over);
	};

	return (
		<div className="gui-surface-tabs" role="tablist" aria-label={ariaLabel} aria-orientation="horizontal">
			<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
				<SortableContext items={tabs.map(t => t.id)} strategy={horizontalListSortingStrategy}>
					{tabs.map(tab => (
						<SurfaceTabButton
							key={tab.id}
							tab={tab}
							active={tab.id === activeId}
							closeLabel={closeLabel}
							onActivate={onActivate}
							onClose={onClose}
						/>
					))}
				</SortableContext>
			</DndContext>
		</div>
	);
}

function SurfaceTabButton({
	tab,
	active,
	closeLabel,
	onActivate,
	onClose,
}: {
	tab: SurfaceTab;
	active: boolean;
	closeLabel: string;
	onActivate(id: string): void;
	onClose(id: string): void;
}): ReactNode {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
	const ref = useRef<HTMLButtonElement | null>(null);

	// Keep the active tab visible when the strip overflows (12 open docs must
	// not hide the current one behind the scroll edge).
	useEffect(() => {
		if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [active]);

	return (
		<button
			ref={node => {
				setNodeRef(node);
				ref.current = node;
			}}
			type="button"
			// dnd-kit's injected attributes (role="button", tabIndex, aria-*)
			// must come FIRST: everything below re-asserts tab semantics on top
			// of them, otherwise every tab becomes a focusable "button" and the
			// roving-tabindex contract is lost.
			{...attributes}
			{...listeners}
			role="tab"
			aria-selected={active}
			tabIndex={active ? 0 : -1}
			className={`gui-surface-tab${active ? " gui-surface-tab--active" : ""}${isDragging ? " gui-surface-tab--dragging" : ""}`}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			onClick={() => onActivate(tab.id)}
			// Middle-click closes (browser default would start autoscroll).
			onAuxClick={e => {
				if (e.button === 1) {
					e.preventDefault();
					onClose(tab.id);
				}
			}}
		>
			<span className="gui-surface-tab-title">{tab.title}</span>
			{tab.dirty ? <span className="gui-surface-tab-dirty" aria-label={tab.title} /> : null}
			<span
				className="gui-surface-tab-close"
				role="button"
				aria-label={`${closeLabel} ${tab.title}`}
				onClick={e => {
					// Without this the click activates the tab before closing it.
					e.stopPropagation();
					onClose(tab.id);
				}}
			>
				×
			</span>
		</button>
	);
}

/**
 * Panel body for a keep-mounted tab strip: instances stay in the DOM hidden
 * with `display:none` (cursor / scroll / iframe state survive), while
 * `unmount` kinds are dropped when inactive. Default is keep-mounted because
 * every current candidate surface (docs, canvas, terminal) loses state on
 * unmount; pass `unmountIds` for the cheap-to-rebuild ones.
 */
export function SurfaceTabPanels({
	tabs,
	activeId,
	unmountIds,
	render,
}: {
	tabs: readonly SurfaceTab[];
	activeId: string | null;
	unmountIds?: ReadonlySet<string>;
	render(tab: SurfaceTab): ReactNode;
}): ReactNode {
	const unmount = useMemo(() => unmountIds ?? new Set<string>(), [unmountIds]);
	return (
		<>
			{tabs.map(tab => {
				const active = tab.id === activeId;
				if (!active && unmount.has(tab.id)) return null;
				return (
					<div
						key={tab.id}
						role="tabpanel"
						hidden={!active}
						style={{ display: active ? undefined : "none" }}
						className="gui-surface-tabpanel"
					>
						{render(tab)}
					</div>
				);
			})}
		</>
	);
}
