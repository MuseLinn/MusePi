import type { Process, ProcessWaitOptions } from "./index.js";

/**
 * Open a stable process reference from a PID, loading the native addon on
 * first use. Keep this subpath free of top-level `loadNative()` calls so
 * worker hosts and `--no-addons` CLI paths can import it without the addon.
 */
export declare function processFromPid(pid: number): Process | null;

/** Whether the referenced pid is still running, loading the native addon on first use. */
export declare function isProcessRunning(pid: number): boolean;

/**
 * Wait until the referenced pid exits, loading the native addon on first
 * use. Resolves `true` when the process is already unobservable.
 */
export declare function waitForProcessExit(pid: number, options?: ProcessWaitOptions | undefined | null): Promise<boolean>;
