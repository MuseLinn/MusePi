/**
 * widget.data FX feed (docs/board-dashboard.md §4 数据源代理): the daemon
 * proxies open.er-api.com so widgets never fetch the network directly.
 * One shared in-process fetch per base currency, cached for 60s; the
 * caller passes an injectable `fetch` (and `now`) for tests.
 */

/** FX feed cache TTL (matches the widget-side 60s cadence). */
export const FX_RATES_TTL_MS = 60_000;

const FX_API = "https://open.er-api.com/v6/latest/";

/** Cache: base code → { fetched-at, normalized numeric rates }. */
const cache = new Map<string, { at: number; value: Record<string, number> }>();
/** One in-flight fetch per base so concurrent RPCs coalesce into one request. */
const inFlight = new Map<string, Promise<Record<string, number> | null>>();

interface FxRatesOptions {
	/** Injectable fetch for tests (defaults to the global). */
	fetch?: typeof fetch;
	/** Injectable clock for cache-age tests (defaults to Date.now). */
	now?: () => number;
}

/**
 * Fetch (with a 60s in-process cache) the normalized rates map for a base
 * currency. open.er-api quotes `rates[CODE]` = how many CODE units equal
 * ONE base unit (e.g. base CNY → rates.EUR = EUR per 1 CNY). Returns null
 * when the source is unreachable or returns a non-success payload — the
 * RPC caller surfaces that as a typed `{ error }` result (never a thrown
 * JSON-RPC error, matching the soft-error convention of git.* RPCs).
 */
export async function getFxRates(base: string, opts: FxRatesOptions = {}): Promise<Record<string, number> | null> {
	const key = base.toUpperCase();
	const now = opts.now?.() ?? Date.now();
	const hit = cache.get(key);
	if (hit && now - hit.at < FX_RATES_TTL_MS) return hit.value;
	const pending = inFlight.get(key);
	if (pending) return pending;
	const run = (async (): Promise<Record<string, number> | null> => {
		try {
			const res = await (opts.fetch ?? fetch)(`${FX_API}${key}`, { signal: AbortSignal.timeout(8000) });
			if (!res.ok) return null;
			const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
			if (json.result !== "success" || !json.rates) return null;
			const rates: Record<string, number> = {};
			for (const [code, value] of Object.entries(json.rates)) {
				if (typeof value === "number" && Number.isFinite(value)) rates[code] = value;
			}
			cache.set(key, { at: now, value: rates });
			return rates;
		} catch {
			// Unreachable / malformed → null; never cached so retries work.
			return null;
		} finally {
			inFlight.delete(key);
		}
	})();
	inFlight.set(key, run);
	return run;
}
