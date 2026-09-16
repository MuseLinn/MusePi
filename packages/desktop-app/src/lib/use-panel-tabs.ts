/**
 * React binding for the panel-level tab model (lib/panel-tabs.ts). State is
 * per cwd (key convention: `musepi-gui-panel-tabs-${cwd}`), persisted to
 * localStorage on every change, and re-loaded when the key changes.
 *
 * All mutators are useCallback-stable: they sit in dependency arrays of
 * ChatView/ContextPanel callbacks and effects, so an unstable identity here
 * would re-run those effects on every render (the openPreview lesson).
 */
import { useCallback, useEffect, useState } from "react";
import {
	closePanelTab,
	closePanelTabs,
	type PanelTabDescriptor,
	type PanelTabState,
	reorderPanelTabs,
	restorePanelTabs,
	serializePanelTabs,
	setPanelTabDirty,
	type UpsertPanelTabOptions,
	upsertPanelTab,
} from "./panel-tabs";

export interface UsePanelTabsResult extends PanelTabState {
	open(descriptor: PanelTabDescriptor, options?: UpsertPanelTabOptions): void;
	close(id: string): void;
	closeMany(ids: readonly string[]): void;
	activate(id: string): void;
	reorder(fromId: string, toId: string): void;
	setDirty(id: string, dirty: boolean): void;
}

function readPanelTabs(storageKey: string): PanelTabState {
	try {
		const raw = localStorage.getItem(storageKey);
		return raw ? restorePanelTabs(JSON.parse(raw)) : { tabs: [], activeId: null };
	} catch {
		return { tabs: [], activeId: null };
	}
}

export function usePanelTabs(storageKey: string): UsePanelTabsResult {
	const [state, setState] = useState<PanelTabState>(() => readPanelTabs(storageKey));

	// cwd arrives asynchronously on cold boot — the storage key changes after
	// mount, so re-load instead of writing the old cwd's layout into the new.
	useEffect(() => {
		setState(readPanelTabs(storageKey));
	}, [storageKey]);

	useEffect(() => {
		try {
			localStorage.setItem(storageKey, JSON.stringify(serializePanelTabs(state)));
		} catch {
			// Storage full / disabled — tab layout is cosmetic, never fatal.
		}
	}, [storageKey, state]);

	const open = useCallback(
		(descriptor: PanelTabDescriptor, options?: UpsertPanelTabOptions): void =>
			setState(s => upsertPanelTab(s, descriptor, options)),
		[],
	);
	const close = useCallback((id: string): void => setState(s => closePanelTab(s, id)), []);
	const closeMany = useCallback((ids: readonly string[]): void => setState(s => closePanelTabs(s, ids)), []);
	const activate = useCallback(
		(id: string): void => setState(s => (s.tabs.some(t => t.id === id) ? { ...s, activeId: id } : s)),
		[],
	);
	const reorder = useCallback(
		(fromId: string, toId: string): void =>
			setState(s => {
				const tabs = reorderPanelTabs(s.tabs, fromId, toId);
				return tabs === s.tabs ? s : { ...s, tabs };
			}),
		[],
	);
	const setDirty = useCallback(
		(id: string, dirty: boolean): void => setState(s => setPanelTabDirty(s, id, dirty)),
		[],
	);

	return { ...state, open, close, closeMany, activate, reorder, setDirty };
}
