import type { FileLock } from "./index.js";

/**
 * Try to acquire `path` without blocking, loading the native addon on first
 * use. Keep this subpath free of top-level `loadNative()` calls so worker
 * hosts and `--no-addons` CLI paths can import it without the addon.
 */
export declare function tryAcquireFileLock(path: string): FileLock;
