/**
 * Shared fetch helper for live widgets (fx / history / stocks / music
 * fallbacks): every widget fetch gets a hard timeout so an unreachable
 * API (blocked network, dead endpoint) degrades into the widget's offline
 * state in seconds instead of hanging for the browser's default minutes
 * and spamming Chromium's SSL-handshake error log on every retry.
 */
export const WIDGET_FETCH_TIMEOUT_MS = 8000;

/** fetch with an AbortSignal timeout; rejects with `TimeoutError`-like
 *  DOMException (name "TimeoutError") when the request exceeds the cap.
 *  `fetchFn` is injectable for testability (defaults to the global). */
export async function widgetFetch(
	url: string,
	init: RequestInit = {},
	timeoutMs: number = WIDGET_FETCH_TIMEOUT_MS,
	fetchFn: typeof fetch = fetch,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchFn(url, {
			...init,
			signal:
				typeof AbortSignal.any === "function" && init.signal
					? AbortSignal.any([init.signal, controller.signal])
					: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}
