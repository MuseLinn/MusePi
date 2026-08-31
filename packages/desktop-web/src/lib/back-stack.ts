/**
 * Back-key layer stack for the Capacitor Android shell.
 *
 * Every modal overlay registers its own close handler with a priority.
 * On the Android back key press, `dispatchBack()` iterates from highest
 * priority (topmost modal) to lowest, stopping at the first handler that
 * returns `true` (consumed). This prevents "one back press closes two
 * layers" — the bug that occurs when every component listens independently
 * on the shared `musepi:back` CustomEvent.
 *
 * Priority values (design doc §3.2 z-order alignment):
 *   100 — AgentDrawer (most modal)
 *    95 — QrScanner (ConnectScreen)
 *    90 — SessionsSheet
 *    85 — ServerSwitcher
 *    80 — AgentsRail
 *    60 — Panel (board/scheduled/files)
 *    40 — Workspace back (session → directory)
 *
 * Only the Capacitor native shell calls `dispatchBack()` — the browser
 * history path is unaffected. Registering a handler in a non-native shell
 * is harmless (no call ever reaches it).
 */

import { useEffect, useRef } from "react";

type BackHandler = () => boolean;

interface BackLayer {
	id: number;
	priority: number;
	handler: BackHandler;
}

const layers: BackLayer[] = [];
let nextId = 0;

/**
 * Register a back-key handler. The handler is called when the Android back
 * key is pressed, from highest-priority handler down. Returns an unregister
 * function.
 *
 * Handlers are called in priority order; the first one returning `true`
 * (consumed) stops the iteration. When `dispatchBack()` returns `false`,
 * the shell falls through to `history.back()` or `exitApp()`.
 */
export function registerBackLayer(priority: number, handler: BackHandler): () => void {
	const layer: BackLayer = { id: nextId++, priority, handler };
	layers.push(layer);
	return () => {
		const i = layers.indexOf(layer);
		if (i >= 0) layers.splice(i, 1);
	};
}

/** Consume the back press: try handlers from highest priority down. */
export function dispatchBack(): boolean {
	// Sort by priority descending; stable within same priority (earlier id first).
	const sorted = [...layers].sort((a, b) => b.priority - a.priority || a.id - b.id);
	for (const layer of sorted) {
		if (layer.handler()) return true;
	}
	return false;
}

/** Reset all registered layers. Used in tests between test cases. */
export function resetBackLayers(): void {
	layers.length = 0;
	nextId = 0;
}

/**
 * React hook: registers a back-layer handler while `active` is true.
 * The handler is kept in a ref so it always reads the latest closure
 * without re-registering on every render.
 */
export function useBackLayer(priority: number, active: boolean, handler: BackHandler): void {
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		if (!active) return;
		return registerBackLayer(priority, () => ref.current());
	}, [priority, active]);
}
