/**
 * Per-event handler budgets, shared by both dispatch paths: the runner's
 * hand-written loops and the Cordis-registered listeners for the lifecycle
 * events. Keeping the state here (instead of in runner.ts) lets the loader
 * import it without a cycle back into the runner.
 */
export const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;
let extensionHandlerTimeoutMs = EXTENSION_HANDLER_TIMEOUT_MS;

export function testSetExtensionHandlerTimeoutMs(timeoutMs: number): void {
	extensionHandlerTimeoutMs = timeoutMs;
}

/** The live default budget (tests may lower it via the setter above). */
export function defaultExtensionHandlerTimeoutMs(): number {
	return extensionHandlerTimeoutMs;
}

export function normalizeHandlerTimeout(timeoutMs: number): number {
	return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : EXTENSION_HANDLER_TIMEOUT_MS;
}

/**
 * Budget signal for work a handler started but did not await (detached tool
 * registrations). `AbortSignal.timeout` would report the platform's generic
 * reason; carrying the handler wording makes the resulting `tool_registration`
 * error name the actual budget, like the executor's own timeout does.
 */
export function handlerTimeoutSignal(timeoutMs: number): AbortSignal {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new DOMException(`Handler timed out after ${timeoutMs}ms`, "TimeoutError"));
	}, timeoutMs);
	timer.unref?.();
	return controller.signal;
}

/**
 * Dedicated cap for `session_shutdown` handlers. The generic 30s budget is
 * appropriate for events extensions can observe (e.g. `session_start`,
 * `before_provider_request`), but `session_shutdown` is fire-and-forget
 * teardown — extensions receive no result and the user has already asked to
 * leave. A hung handler (e.g. an extension waiting on a stuck IPC pipe to a
 * companion app) MUST NOT hold Ctrl+C / `/exit` hostage for the full window.
 * See issue #2600.
 */
export const SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 2_000;
let sessionShutdownHandlerTimeoutMs = SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS;

export function testSetSessionShutdownHandlerTimeoutMs(timeoutMs: number): void {
	sessionShutdownHandlerTimeoutMs = timeoutMs;
}

/** Per-event handler budget. Defaults to the generic cap; `session_shutdown`
 *  uses its own short cap so teardown stays prompt. */
export function handlerTimeoutForEvent(eventType: string): number {
	return eventType === "session_shutdown" ? sessionShutdownHandlerTimeoutMs : extensionHandlerTimeoutMs;
}
