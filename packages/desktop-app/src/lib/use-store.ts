import { useSyncExternalStore } from "react";

/** Subscribe a React component to an external store (GuiSessionStore etc.). */
export function useStore<T>(subscribe: (cb: () => void) => () => void, get: () => T): T {
	return useSyncExternalStore(subscribe, get, get);
}
