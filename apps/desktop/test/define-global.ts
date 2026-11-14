/**
 * Test-global installer that survives happy-dom pollution. Any test file that
 * imports `happy-dom-shim` runs `GlobalRegistrator.register()`, which leaves
 * getter-only accessors (localStorage, window, …) on globalThis. A later test
 * file's plain assignment to such a global silently no-ops (no setter), so
 * its stub never installs and the suite goes red in full runs while every
 * file passes alone. `Object.defineProperty` redefines the accessor outright.
 */
export function defineGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
