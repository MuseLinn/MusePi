/**
 * Transport bridge between the ported sidebar UI and the MusePi daemon.
 *
 * The sidebar's client code calls `POST /sidebar/api/<method>` and unwraps a
 * `{ok:true, value}` envelope. This host answers RPC over a single WebSocket
 * with JSON-RPC 2.0, has no REST surface, and returns the result directly
 * rather than wrapped. So the ported UI cannot run against this daemon until its
 * every-call chokepoint is redirected — that is what this module does: one
 * function the whole API surface will funnel through.
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
 *   • Some near-named routes return different shapes between the two ends of
 *     this bridge — the sidebar's `fs.remove` expects a `{path}` result while
 *     this host's `fs.delete` answers `{ok:true}` — so identity is not always
 *     enough. But reshaping is a per-method decision with its own test, not a
 *     global rule; a method that needs one carries its verified adapter with
 *     the test that proves it, rather than a speculative mechanism here.
 *
 * The error type matches the sidebar's own name and code vocabulary so a
 * component's existing `catch` keeps working unchanged; only the production of
 * that error moved.
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
 *
 *   The generic is the CALLER'S view, not the wire shape: adapted routes
 *   return the sidebar's shape (declared via `callSidebar<SidebarGitBranch>`
 *   etc.) even though a different method name and envelope travelled the
 *   wire, so a ported component's type annotations hold unchanged.
 */
export async function callSidebar<T>(
	rpc: RpcTransport,
	method: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) throw new SidebarApiError("network", "aborted");

	// Adapted routes. `git.branch` renames to `git.branches` AND reshapes;
	// `git.worktrees` keeps its name but unwraps the host's `{worktrees}`
	// envelope into the bare list the sidebar consumes. Everything else
	// forwards by identity. The adapter results are the caller's declared
	// shape, hence the single narrowed cast at the return boundary.
	const request: Promise<unknown> =
		method === "git.branch"
			? settle(rpc.request<{ current: string | null; branches: string[] }>("git.branches", payload)).then(result =>
					adaptGitBranches(result),
				)
			: method === "git.worktrees"
				? settle(rpc.request<{ worktrees?: unknown[] }>("git.worktrees", payload)).then(result =>
						adaptGitWorktrees(result),
					)
				: settle(rpc.request<T>(method, payload));
	if (!signal) return request as Promise<T>;

	// Abort releases the caller, but the request cannot be cancelled and keeps
	// running. That is safe here because `settle` awaits the request inside its
	// own try/catch: a rejection that lands after the abort is still caught and
	// never reaches the process's unhandledRejection handler — which in this host
	// would mean a postmortem tearing down every live session.
	const abort = new Promise<never>((_, reject) => {
		signal.addEventListener("abort", () => reject(new SidebarApiError("network", "aborted")), { once: true });
	});
	return Promise.race([request, abort]) as Promise<T>;
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

/* ── Verified adapters (one per near-named route, each with a test) ──────── */

/**
 * The sidebar's `git.branch` → this host's `git.branches`.
 *
 * The two routes do not just differ in name; the payloads are different
 * shapes, verified against both sides rather than assumed:
 *
 *   sidebar `GitBranch` (what components consume — GitView's
 *   `localBranches` derives from `.all`, the selector renders
 *   `branchInfo?.[name]?.ahead` with optional chaining throughout):
 *
 *     { all: string[]; current: string;
 *       branches: Record<name, { current, name, commit, label, ahead?, behind? }>;
 *       defaultBranches?: Record<string, string> }
 *
 *   this host's `git.branches` (server.ts): `{ current: string | null,
 *   branches: string[] }` — names only, local heads, no detail.
 *
 * The adapter lifts names into the sidebar's shape. Detail fields the host
 * cannot answer (commit hash, tracking, ahead/behind) are left out on
 * purpose: every consumer reads them through optional chaining or treats a
 * missing detail entry as normal (the reference's own git API documentation
 * pins that tolerance), so omitting them degrades the UI to plain names
 * instead of fabricating data.
 */
interface SidebarGitBranch {
	all: string[];
	current: string;
	branches: Record<string, { current: boolean; name: string }>;
}

function adaptGitBranches(host: { current: string | null; branches: string[] }): SidebarGitBranch {
	const current = host.current ?? "";
	return {
		all: host.branches,
		current,
		branches: Object.fromEntries(host.branches.map(name => [name, { current: name === current, name }])),
	};
}

/**
 * The sidebar's `git.worktrees` → this host's `git.worktrees` (same name,
 * different envelope). The sidebar's HTTP client returned the list BARE
 * (`GitWorktreeInfo[]` — `gitApiHttp.listGitWorktrees` json()s the body
 * straight through), while this host answers `{worktrees: [...]}`. The
 * entries themselves line up field-for-field: head/name/branch/path plus
 * `prunable`, with the daemon already stripping the `refs/heads/` prefix
 * the sidebar's consumers otherwise handle on their side.
 */
function adaptGitWorktrees(host: { worktrees?: unknown[] }): unknown[] {
	return Array.isArray(host.worktrees) ? host.worktrees : [];
}
