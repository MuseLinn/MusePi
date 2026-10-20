/**
 * Shared settle for tests that drive GuiSessionStore.
 *
 * The store coalesces applies: the first event of a burst flushes on the next
 * microtask, then a 100 ms window accumulates the rest. Two microtask yields
 * therefore settle the common case, and the loop below waits out a window that
 * is still holding work (a second apply landing mid-window). The old
 * requestAnimationFrame wait stays for suites that drive rAF-driven UI on top
 * of the store.
 */
import { hasPendingSessionFlush } from "../src/lib/session-store";

export async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	// Bounded: a pathological stream must not hang a test.
	for (let i = 0; i < 12 && hasPendingSessionFlush(); i++) {
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === "function") {
		await new Promise(resolve => setTimeout(resolve, 30));
	}
}
