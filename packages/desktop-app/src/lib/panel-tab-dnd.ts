/**
 * Drop resolution for the right panel's tab strips.
 *
 * dnd-kit's stock strategies don't fit the split layout: `closestCenter` flips
 * between a small chip and the column-sized zone under the pointer (the strips
 * animate every frame), while pure containment loses the verdict whenever the
 * pointer sits in a gap — the drag then ends with `over: null` and the tab
 * snaps back. This resolver keeps containment as the authority (a chip beats
 * the zone that contains it) and adds the one fallback the gesture needs:
 *
 * - a pointer inside the dragged tab's OWN column but not over a chip resolves
 *   to that column's nearest chip, so releasing between chips reorders;
 * - a pointer outside every droppable resolves to the nearest chip within
 *   `gapFallbackPx`, so dropping just off the strip still lands.
 *
 * Cross-column verdicts stay zone-authoritative: a release over another
 * column's empty space moves the tab there, never "reorders" into it.
 */
import type { ClientRect } from "@dnd-kit/core";

type PanelColumnIndex = 0 | 1;

interface PanelDropTab {
	readonly id: string;
	readonly column: PanelColumnIndex;
}

export interface PanelDropZone {
	readonly id: string;
	readonly column: PanelColumnIndex;
	/** `split` is the single-layout "make a second column" target: it must win
	 *  over the own-column chip fallback. */
	readonly kind?: "column" | "split";
}

export interface PanelDropQuery {
	/** The tab being dragged. */
	readonly activeId: string;
	/** Pointer position in viewport coordinates (dnd-kit's value). */
	readonly pointer: { readonly x: number; readonly y: number };
	/** Measured rect per droppable id (chips and column zones). */
	readonly rects: ReadonlyMap<string, ClientRect>;
	readonly tabs: readonly PanelDropTab[];
	readonly zones: readonly PanelDropZone[];
	/** How far outside a chip still counts as that chip (default 48px). */
	readonly gapFallbackPx?: number;
}

export interface PanelDropResult {
	readonly id: string;
	readonly kind: "tab" | "zone";
}

const DEFAULT_GAP_FALLBACK_PX = 48;

/** A collision pass always needs a pointer. dnd-kit reports null on the first
 *  pass and for keyboard activation; returning no collisions there ends the
 *  drag with `over: null`, so the tab snaps back. The dragged chip's centre is
 *  the closest stable substitute. */
export function panelDropPointer(
	pointerCoordinates: { readonly x: number; readonly y: number } | null,
	collisionRect: ClientRect,
): { x: number; y: number } {
	return (
		pointerCoordinates ?? {
			x: collisionRect.left + collisionRect.width / 2,
			y: collisionRect.top + collisionRect.height / 2,
		}
	);
}

function contains(rect: ClientRect, x: number, y: number): boolean {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function area(rect: ClientRect): number {
	return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/** Distance from the pointer to the chip's box: zero inside, otherwise the
 *  straight-line gap to the nearest edge. Wide chips therefore stay reachable
 *  from just outside their edge, which centre distance would miss. */
function boxDistance(rect: ClientRect, x: number, y: number): number {
	const dx = Math.max(rect.left - x, 0, x - rect.right);
	const dy = Math.max(rect.top - y, 0, y - rect.bottom);
	return Math.hypot(dx, dy);
}

/** Nearest chip of one column, or null when that column holds no measured chip. */
function nearestTabInColumn(
	query: PanelDropQuery,
	column: PanelColumnIndex,
	excludeId?: string,
): { id: string; distance: number } | null {
	let best: { id: string; distance: number } | null = null;
	for (const tab of query.tabs) {
		if (tab.column !== column || tab.id === excludeId) continue;
		const rect = query.rects.get(tab.id);
		if (!rect) continue;
		const distance = boxDistance(rect, query.pointer.x, query.pointer.y);
		if (best === null || distance < best.distance) best = { id: tab.id, distance };
	}
	return best;
}

/**
 * Resolve the drop target for a pointer position, or null when the gesture
 * should land nowhere.
 */
export function resolvePanelDrop(query: PanelDropQuery): PanelDropResult | null {
	const { pointer, rects } = query;
	const activeTab = query.tabs.find(tab => tab.id === query.activeId);
	const activeColumn = activeTab?.column;

	// 1) Containment: the smallest containing box wins, so a chip beats the
	// column zone that also contains the pointer.
	let bestContained: { id: string; kind: "tab" | "zone"; column: PanelColumnIndex; area: number } | null = null;
	for (const tab of query.tabs) {
		const rect = rects.get(tab.id);
		if (!rect || !contains(rect, pointer.x, pointer.y)) continue;
		const size = area(rect);
		if (bestContained === null || size < bestContained.area) {
			bestContained = { id: tab.id, kind: "tab", column: tab.column, area: size };
		}
	}
	for (const zone of query.zones) {
		const rect = rects.get(zone.id);
		if (!rect || !contains(rect, pointer.x, pointer.y)) continue;
		const size = area(rect);
		if (bestContained === null || size < bestContained.area) {
			bestContained = { id: zone.id, kind: "zone", column: zone.column, area: size };
		}
	}

	if (bestContained) {
		// Releasing inside the dragged tab's own column, off any chip, means
		// "insert into this column" — pick its nearest OTHER chip so the strip
		// reorders (nearest to itself would be a no-op drop). The split target
		// is excluded: it means "new column", not "reorder".
		const splitTarget = query.zones.some(zone => zone.id === bestContained?.id && zone.kind === "split");
		if (
			!splitTarget &&
			bestContained.kind === "zone" &&
			activeColumn !== undefined &&
			bestContained.column === activeColumn
		) {
			const nearest = nearestTabInColumn(query, activeColumn, query.activeId);
			if (nearest) return { id: nearest.id, kind: "tab" };
		}
		return { id: bestContained.id, kind: bestContained.kind };
	}

	// 2) Gap fallback: just off the strip still means the nearest chip.
	const fallbackPx = query.gapFallbackPx ?? DEFAULT_GAP_FALLBACK_PX;
	let nearest: { id: string; distance: number } | null = null;
	for (const tab of query.tabs) {
		const rect = rects.get(tab.id);
		if (!rect) continue;
		const distance = boxDistance(rect, pointer.x, pointer.y);
		if (nearest === null || distance < nearest.distance) nearest = { id: tab.id, distance };
	}
	return nearest && nearest.distance <= fallbackPx ? { id: nearest.id, kind: "tab" } : null;
}
