/**
 * Shared settle for tests that drive GuiSessionStore. The store coalesces
 * applies via requestAnimationFrame when that global exists, falling back to
 * microtasks otherwise. Bun's own runtime has no rAF — but a test file that
 * imported happy-dom-shim earlier in the SAME process leaves happy-dom's rAF
 * on globalThis, and its frame ticks on a real timer, not a microtask. Two
 * microtask yields alone then no longer reach the flush: full-suite runs go
 * red while every file passes alone. When rAF is present, give the frame a
 * real-timer turn (30ms ≫ happy-dom's ~16ms frame).
 */
export async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === "function") {
		await new Promise(resolve => setTimeout(resolve, 30));
	}
}
