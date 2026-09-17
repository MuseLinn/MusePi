/**
 * Prompt-cache hit rate — one implementation, shared by the TUI status line
 * (`cache_hit` segment) and the daemon's `session.contextUsage` response, so
 * the desktop GUI and the terminal can never disagree about the number.
 */

/** The usage counters the hit rate is derived from. */
export interface CacheCounters {
	cacheRead?: number;
	cacheWrite?: number;
	input?: number;
}

/**
 * Hit rate = cacheRead / (cacheRead + cacheWrite + input) * 100.
 *
 * The prompt is the sum of cacheRead (served from cache), cacheWrite (newly
 * cached this turn) and input (uncached). Including uncached input keeps the
 * denominator honest for Anthropic/OpenRouter; DeepSeek reports its miss as
 * input with cacheWrite 0, so this still yields hit/(hit+miss).
 *
 * Returns null when there is nothing to report (no cache reads at all) — the
 * callers hide the field instead of showing a misleading 0%.
 */
export function cacheHitRate(counters: CacheCounters | null | undefined): number | null {
	const read = counters?.cacheRead ?? 0;
	if (read <= 0) return null;
	const total = read + (counters?.cacheWrite ?? 0) + (counters?.input ?? 0);
	if (total <= 0) return null;
	return (read / total) * 100;
}
