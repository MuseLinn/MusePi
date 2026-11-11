import type { StreamEvent } from "./rpc";
import type { GuiSessionStore } from "./session-store";

/**
 * Side-session store registry.
 *
 * The app's RPC event pump has one active store. A session opened in the
 * right panel is a second live session, so its store needs the same stream
 * without stealing the active session's envelopes. Views register their
 * store here; the pump routes by `event.sessionId` before the active-store
 * cross-session guard.
 *
 * Ask requests stay outside the store: `GuiSessionStore` models the main
 * chat's approval cards, while a side view keeps its own ask card above its
 * composer. Event listeners therefore receive ask envelopes directly.
 */
const stores = new Map<string, GuiSessionStore>();
const eventListeners = new Map<string, Set<(event: StreamEvent) => void>>();

export function registerSideSessionStore(store: GuiSessionStore): void {
	stores.set(store.sessionId, store);
}

export function unregisterSideSessionStore(sessionId: string): void {
	stores.delete(sessionId);
}

export function getSideSessionStore(sessionId: string): GuiSessionStore | undefined {
	return stores.get(sessionId);
}

/** Raw side-session envelopes (currently asks) for the view's own UI state. */
export function subscribeSideSessionEvents(sessionId: string, listener: (event: StreamEvent) => void): () => void {
	let listeners = eventListeners.get(sessionId);
	if (!listeners) {
		listeners = new Set();
		eventListeners.set(sessionId, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) eventListeners.delete(sessionId);
	};
}

/**
 * Apply one envelope to a registered side-session store.
 * @returns true when the envelope belonged to a side session and was consumed.
 */
export function applySideSessionEvent(event: StreamEvent): boolean {
	const sessionId = event.sessionId;
	if (!sessionId) return false;
	const store = stores.get(sessionId);
	if (!store) return false;
	if (event.kind === "ask-request" || event.kind === "ask-request-end") {
		for (const listener of eventListeners.get(sessionId) ?? []) listener(event);
		return true;
	}
	store.apply(event);
	return true;
}
