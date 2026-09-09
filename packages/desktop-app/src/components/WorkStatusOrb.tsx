import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type { GuiSessionStore } from "../lib/session-store";
import { ThinkingOrb } from "../vendor/thinking-orbs";

function useStore<T>(subscribe: (cb: () => void) => () => void, get: () => T): T {
	return useSyncExternalStore(subscribe, get, get);
}

/**
 * Inline agent-activity indicator: a small thinking-orb (canvas,
 * theme-aware via data-theme) that appears while a session streams a
 * turn. Sits next to the daemon chip in the top bar.
 */
export function WorkStatusOrb({ store }: { store: GuiSessionStore | null }): ReactNode {
	const snap = useStore(
		store?.subscribe.bind(store) ?? (() => () => {}),
		store?.getSnapshot.bind(store) ?? (() => null),
	);
	if (!snap?.working) return null;
	return (
		<span className="gui-work-orb" role="status" aria-label="agent working">
			<ThinkingOrb state="working" size={20} />
		</span>
	);
}
