import { loadNative } from "./loader-state.js";

let cached = null;
function bindings() {
	return (cached ??= loadNative());
}

/**
 * Open a stable process reference from a PID, loading the native addon on
 * first use. Keep this subpath free of top-level `loadNative()` calls so
 * worker hosts and `--no-addons` CLI paths can import it without the addon.
 */
export function processFromPid(pid) {
	return bindings().Process.fromPid(pid);
}

/** Whether the referenced pid is still running, loading the native addon on first use. */
export function isProcessRunning(pid) {
	const native = bindings();
	return native.Process.fromPid(pid)?.status() === native.ProcessStatus.Running;
}

/**
 * Wait until the referenced pid exits, loading the native addon on first
 * use. Resolves `true` when the process is already unobservable.
 */
export function waitForProcessExit(pid, options) {
	const proc = bindings().Process.fromPid(pid);
	return proc ? proc.waitForExit(options) : Promise.resolve(true);
}
