/** React binding for {@link GuestClient} / {@link HostClient} via
 *  `useSyncExternalStore`. The structural type covers both transports — the
 *  guest (collab frames) and the host (daemon JSON-RPC) expose the same
 *  `GuestSnapshot` contract. */
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { GuestSnapshot, SessionClient } from "./client";

export type { SessionClient };

export function useGuestSnapshot(client: SessionClient): GuestSnapshot {
	return useSyncExternalStore(
		listener => client.subscribe(listener),
		() => client.getSnapshot(),
		() => client.getSnapshot(),
	);
}

/**
 * Field-level subscription: re-renders only when the selector's result
 * changes (Object.is). The selector must return a stable reference (a
 * snapshot field) or a primitive — a derived object compares unequal every
 * frame and defeats the memoization (and can loop the store).
 */
export function useGuestSelector<T>(client: SessionClient, selector: (snap: GuestSnapshot) => T): T {
	const selectorRef = useRef(selector);
	selectorRef.current = selector;
	const get = useCallback(() => selectorRef.current(client.getSnapshot()), [client]);
	return useSyncExternalStore(
		useCallback(listener => client.subscribe(listener), [client]),
		get,
		get,
	);
}
