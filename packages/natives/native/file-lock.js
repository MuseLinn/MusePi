import { loadNative } from "./loader-state.js";

let cached = null;
function bindings() {
	return (cached ??= loadNative());
}

/**
 * Try to acquire `path` without blocking, loading the native addon on first
 * use. Keep this subpath free of top-level `loadNative()` calls so worker
 * hosts and `--no-addons` CLI paths can import it without the addon.
 */
export function tryAcquireFileLock(path) {
	return bindings().FileLock.tryAcquire(path);
}
