/**
 * Header session tabs — the window's horizontal working set of sessions.
 *
 * The store owns session ids, their order, and the single preview id (each
 * persisted separately in localStorage); titles and live status resolve at
 * render time from the app's session metadata. A tab is a per-client projection:
 * closing one never touches the session itself, and ids whose session the
 * client has not loaded stay stored but do not render (a partially loaded
 * session list must not destroy the working set).
 */
import { useSyncExternalStore } from "react";

export const SESSION_TABS_ENABLED_KEY = "musepi-gui-session-tabs";
export const SESSION_TAB_IDS_KEY = "musepi-gui-session-tab-ids";
export const SESSION_PREVIEW_TAB_ID_KEY = "musepi-gui-session-preview-tab-id";
/** Fired on window when the enabled toggle changes (settings page and header
 * live in different subtrees; storage events only reach OTHER windows). */
export const SESSION_TABS_CHANGED_EVENT = "musepi-gui-session-tabs-changed";

/**
 * Soft cap: opening sessions auto-adds tabs, so the strip only grows. Past
 * the cap the OLDEST tab leaves the working set — never the one being
 * opened, which always lands last.
 */
export const MAX_SESSION_TABS = 10;

/** Live view of the settings toggle (multi-session header tabs). */
export function useSessionTabsEnabled(): boolean {
	return useSyncExternalStore(subscribeEnabled, () => readEnabled());
}

function readEnabled(storage: StorageLike | null = defaultStorage()): boolean {
	if (!storage) return false;
	try {
		return storage.getItem(SESSION_TABS_ENABLED_KEY) === "1";
	} catch {
		return false;
	}
}

/** The toggle lives in the settings subtree, the strip in the header — the
 * settings page fires SESSION_TABS_CHANGED_EVENT; storage events cover
 * changes from other windows. */
function subscribeEnabled(onStoreChange: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	const handler = () => onStoreChange();
	window.addEventListener("storage", handler);
	window.addEventListener(SESSION_TABS_CHANGED_EVENT, handler);
	return () => {
		window.removeEventListener("storage", handler);
		window.removeEventListener(SESSION_TABS_CHANGED_EVENT, handler);
	};
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
	try {
		return localStorage;
	} catch {
		return null;
	}
}

export function loadTabIds(storage: StorageLike | null = defaultStorage()): string[] {
	if (!storage) return [];
	try {
		const raw = storage.getItem(SESSION_TAB_IDS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
	} catch {
		return [];
	}
}

export function saveTabIds(ids: readonly string[], storage: StorageLike | null = defaultStorage()): void {
	if (!storage) return;
	try {
		storage.setItem(SESSION_TAB_IDS_KEY, JSON.stringify(ids));
	} catch {
		// storage unavailable — the working set just won't persist
	}
}

export function loadPreviewTabId(storage: StorageLike | null = defaultStorage()): string | null {
	if (!storage) return null;
	try {
		return storage.getItem(SESSION_PREVIEW_TAB_ID_KEY) || null;
	} catch {
		return null;
	}
}

export function savePreviewTabId(previewTabId: string | null, storage: StorageLike | null = defaultStorage()): void {
	if (!storage) return;
	try {
		storage.setItem(SESSION_PREVIEW_TAB_ID_KEY, previewTabId ?? "");
	} catch {
		// storage unavailable — preview state just won't persist
	}
}

export interface SessionTabPreviewState {
	ids: string[];
	previewTabId: string | null;
}

export function openPreviewTab(
	ids: readonly string[],
	previewTabId: string | null,
	sessionId: string,
): SessionTabPreviewState {
	if (!sessionId || ids.includes(sessionId)) return { ids: [...ids], previewTabId };
	if (previewTabId) {
		const previewIndex = ids.indexOf(previewTabId);
		if (previewIndex >= 0) {
			const next = [...ids];
			next[previewIndex] = sessionId;
			return { ids: next, previewTabId: sessionId };
		}
	}
	return { ids: ensureTabId(ids, sessionId), previewTabId: sessionId };
}

export function pinPreviewTab(previewTabId: string | null, sessionId: string): string | null {
	return previewTabId === sessionId ? null : previewTabId;
}

export function clearPreviewTab(previewTabId: string | null, sessionId: string): string | null {
	return pinPreviewTab(previewTabId, sessionId);
}

/** Append a session's tab (idempotent). Returns the same array when nothing changed. */
export function ensureTabId(ids: readonly string[], sessionId: string): string[] {
	if (!sessionId) return [...ids];
	if (ids.includes(sessionId)) return [...ids];
	const next = [...ids, sessionId];
	return next.length > MAX_SESSION_TABS ? next.slice(next.length - MAX_SESSION_TABS) : next;
}

export function removeTabId(ids: readonly string[], sessionId: string): string[] {
	if (!ids.includes(sessionId)) return [...ids];
	return ids.filter(id => id !== sessionId);
}

/** Keep only the given tab (no-op when it is the only one). */
export function closeOtherTabIds(ids: readonly string[], sessionId: string): string[] {
	if (!ids.includes(sessionId)) return [...ids];
	if (ids.length === 1) return [...ids];
	return [sessionId];
}

export function reorderTabIds(ids: readonly string[], activeId: string, overId: string): string[] {
	const from = ids.indexOf(activeId);
	const to = ids.indexOf(overId);
	if (from < 0 || to < 0 || from === to) return [...ids];
	const next = [...ids];
	next.splice(to, 0, ...next.splice(from, 1));
	return next;
}

/**
 * Whether a tab's session is known to the client right now (metadata or
 * tree row exists). Unknown ids stay stored but do not render, and never
 * count as neighbours for activation.
 */
export type TabRenderable = (id: string) => boolean;

function renderableIds(ids: readonly string[], renderable: TabRenderable): string[] {
	return ids.filter(id => renderable(id));
}

/**
 * Close one tab. Closing the CURRENT tab activates its right neighbour
 * (falling back left); null means the caller opens a new-session draft.
 * Closing any other tab just removes it.
 */
export function closeTabAndActivateNeighbour(
	ids: readonly string[],
	sessionId: string,
	currentId: string | null,
	renderable: TabRenderable,
): { ids: string[]; nextId: string | null } {
	if (!ids.includes(sessionId)) return { ids: [...ids], nextId: null };
	if (sessionId !== currentId) return { ids: removeTabId(ids, sessionId), nextId: null };
	const renderableNow = renderableIds(ids, renderable);
	const index = renderableNow.indexOf(sessionId);
	const neighbourId = renderableNow[index + 1] ?? renderableNow[index - 1] ?? null;
	return { ids: removeTabId(ids, sessionId), nextId: neighbourId };
}

/** The tab one step right (+1) or left (−1) of the current, wrapping around the
 * ends of the RENDERED order. null when the current session has no tab. */
export function adjacentTabId(
	ids: readonly string[],
	currentId: string | null,
	delta: -1 | 1,
	renderable: TabRenderable,
): string | null {
	const renderableNow = renderableIds(ids, renderable);
	if (!currentId || renderableNow.length < 2) return null;
	const index = renderableNow.indexOf(currentId);
	if (index === -1) return null;
	return renderableNow[(index + delta + renderableNow.length) % renderableNow.length] ?? null;
}

/** Activate the nth (0-based) RENDERED tab. null when out of range. */
export function tabIdAtIndex(ids: readonly string[], index: number, renderable: TabRenderable): string | null {
	const renderableNow = renderableIds(ids, renderable);
	return renderableNow[index] ?? null;
}
