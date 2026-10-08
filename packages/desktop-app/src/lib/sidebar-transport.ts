/**
 * Transport bridge between the ported sidebar UI and the MusePi daemon.
 *
 * The sidebar's client code calls `POST /sidebar/api/<method>` and unwraps a
 * `{ok:true, value}` envelope (dsh's contract). This host answers RPC over a
 * single WebSocket with JSON-RPC 2.0, has no REST surface, and returns the
 * result directly rather than wrapped. So the ported UI cannot run against this
 * daemon until its every-call chokepoint is redirected — that is what this
 * module does: one function the whole API surface will funnel through.
 *
 * It forwards by identity and does NOT judge a successful result's shape. Two
 * reasons, both found by reading the actual hosts rather than assumed:
 *
 *   • A resolved `{error}` field means different things per route — a refusal
 *     (archive.build rejected the selection) or ordinary data (archive.status
 *     reporting a failed build). A blanket "throw on {error}" here would either
 *     swallow real results or invent failures, so the transport only reacts to
 *     errors the RPC layer itself raises.
 *
 *   • Some near-named routes return different shapes (`fs.remove` answers
 *     `{path}` in dsh, `{ok:true}` in MusePi's `fs.delete`), so identity is not
 *     always enough — but reshaping is a per-method decision with its own test,
 *     not a global rule. When a method needs one, the adapter lives with the
 *     method's own verified test rather than as an empty mechanism here.
 *
 * The error type mirrors the sidebar's own so a component's existing `catch`
 * keeps working unchanged; only the production of that error moved.
 */

/** The slice of `RpcClient` this bridge needs, kept structural so the transport
 *  can be tested with a stub instead of a live daemon. */
export interface RpcTransport {
	request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

/** A wire failure, carrying the code the component branches on. Same name and
 *  code vocabulary as the sidebar's `SidebarApiError` so ported components that
 *  `instanceof`-check it or read `.code` need no edit. */
export class SidebarApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SidebarApiError";
	}
}

/**
 * Run one sidebar API call over the daemon's transport.
 *
 * The method name is forwarded unchanged and the payload passed through; a
 * route this host does not answer rejects at the RPC layer and surfaces below
 * as a `'host'` error — the honest signal, rather than a guessed alias.
 *
 * @param signal - the component's AbortSignal. `RpcClient` has no per-request
 *   cancel, so aborting is a race: the caller is released now while the
 *   in-flight request keeps running. The sidebar's own `fetch(signal)` abort
 *   surfaced as a `'network'` code, which is what this reproduces; a component
 *   telling abort from a real failure keys on `signal.aborted` or the message,
 *   as before.
 */
export async function callSidebar<T>(
	rpc: RpcTransport,
	method: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) throw new SidebarApiError("network", "aborted");

	const request = settle(rpc.request<T>(method, payload));
	if (!signal) return request;

	// Abort releases the caller, but the request cannot be cancelled and keeps
	// running. That is safe here because `settle` awaits the request inside its
	// own try/catch: a rejection that lands after the abort is still caught and
	// never reaches the process's unhandledRejection handler — which in this host
	// would mean a postmortem tearing down every live session.
	const abort = new Promise<never>((_, reject) => {
		signal.addEventListener("abort", () => reject(new SidebarApiError("network", "aborted")), { once: true });
	});
	return Promise.race([request, abort]);
}

/** Translate the RPC layer's rejection into the sidebar's error type. A
 *  JSON-RPC error becomes a `'host'` code — the daemon's "Unknown method" or a
 *  route-level throw — because that is the closest thing to the HTTP-level code
 *  the sidebar would have received. */
async function settle<T>(request: Promise<T>): Promise<T> {
	try {
		return await request;
	} catch (err) {
		if (err instanceof SidebarApiError) throw err;
		throw new SidebarApiError("host", err instanceof Error ? err.message : String(err));
	}
}
