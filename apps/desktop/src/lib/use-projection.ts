/**
 * Key-addressed projection reader over a GUI session store.
 *
 * The store receives host-computed whole values (`kind:"projection"` frames
 * plus the resume baseline). Components subscribe by key; `undefined` is the
 * uniform "no value yet" state, never a fabricated zero.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { GuiSessionStore } from "./session-store";

export function useSessionProjection<T>(store: GuiSessionStore | null | undefined, key: string): T | undefined {
	const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => {}), [store]);
	const getSnapshot = useCallback(() => store?.getSnapshot().projections.get(key) as T | undefined, [store, key]);
	return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}
