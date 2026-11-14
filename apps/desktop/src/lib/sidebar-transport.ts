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

	// Adapted routes (one entry per near-named/reshaped method, each with its
	// verified adapter + test below). Everything else forwards by identity.
	// The adapter results are the caller's declared shape, hence the single
	// narrowed cast at the return boundary.
	const adapter = ADAPTED_ROUTES[method];
	const request: Promise<unknown> = adapter ? adapter(rpc, payload) : settle(rpc.request<T>(method, payload));
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

/** One adapted route: the wire method to call and the result reshape. */
type AdaptedRoute = (rpc: RpcTransport, payload: Record<string, unknown>) => Promise<unknown>;

const ADAPTED_ROUTES: Record<string, AdaptedRoute> = {
	// Sidebar `git.branch` → host `git.branches` (rename + reshape).
	"git.branch": (rpc, payload) =>
		settle(rpc.request<{ current: string | null; branches: string[] }>("git.branches", payload)).then(result =>
			adaptGitBranches(result),
		),
	// Sidebar `git.worktrees` → same name, unwrap `{worktrees}`.
	"git.worktrees": (rpc, payload) =>
		settle(rpc.request<{ worktrees?: unknown[] }>("git.worktrees", payload)).then(result =>
			adaptGitWorktrees(result),
		),
	// Sidebar `git.log` → same name, reshape into the sidebar's
	// `{all, latest, total}` entry shape (see adaptGitLog).
	"git.log": (rpc, payload) =>
		settle(rpc.request<HostGitLog>("git.log", payload)).then(result => adaptGitLog(result, payload)),
	// Sidebar `commit.files` → host `git.show` with numstat (see adaptCommitFiles).
	"commit.files": (rpc, payload) =>
		settle(rpc.request<HostGitShow>("git.show", { ...payload, maxLines: 1 })).then(result =>
			adaptCommitFiles(result),
		),
	// Sidebar `commit.fileDiff` → host `git.show` (see adaptCommitFileDiff).
	"commit.fileDiff": (rpc, payload) =>
		settle(rpc.request<HostGitShow>("git.show", payload)).then(result => adaptCommitFileDiff(result, payload)),
};

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

/**
 * The sidebar's `git.log` → this host's `git.log` (same name, different
 * entry shape). The sidebar consumes (gitLogSchema, zod-parsed):
 *
 *     { all: [{ hash, date, message, refs, body, author_name,
 *               author_email, filesChanged, insertions, deletions,
 *               parents }], latest, total }
 *
 * while the host answers `{ commits: [{hash, shortHash, author, timestamp,
 * refs: [{kind,name}], parents, subject}], hasMore }`.
 *
 * Field mapping: subject → message; the structured refs fold back into the
 * single decoration string the sidebar renders (`HEAD -> main, tag: x`);
 * date comes from the timestamp (ISO, what `git log --format=%aI` would
 * give). filesChanged/insertions/deletions and body are NOT answered — the
 * host would need a `--numstat` per commit for the counts and `%B` for the
 * body. The sidebar's zod schema requires them, so they are filled with
 * zero/empty rather than omitted; the history list renders the summary
 * line, and the counts a row shows inline stay 0 until a real need pins
 * them (the reference's own list rows read them only for the "+n −m" chip).
 */
interface HostGitLog {
	commits?: Array<{
		hash: string;
		shortHash: string;
		author: string;
		timestamp: number;
		refs: { kind: string; name: string }[];
		parents: string[];
		subject: string;
	}>;
	hasMore?: boolean;
}

function adaptGitLog(host: HostGitLog, payload: Record<string, unknown>): unknown {
	const commits = Array.isArray(host.commits) ? host.commits : [];
	const all = commits.map(c => ({
		hash: c.hash,
		date: new Date(c.timestamp || 0).toISOString(),
		message: c.subject ?? "",
		refs: (c.refs ?? []).map(r => (r.kind === "head" ? `HEAD -> ${r.name}` : r.name)).join(", "),
		body: "",
		author_name: c.author ?? "",
		author_email: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		parents: c.parents ?? [],
	}));
	return { all, latest: all[0] ?? null, total: all.length + (host.hasMore ? 1 : 0) };
}

/**
 * The sidebar's `commit.files` → this host's `git.show`. The sidebar fetches
 * a commit's changed-file list as
 *
 *     { files: [{ path, previousPath?, changeType, insertions,
 *                 deletions, isBinary }] }
 *
 * while the host answers one commit's metadata + the whole unified patch.
 * The adapter parses per-file sections out of the patch (`diff-tree -r -p`
 * output: `diff --git a/x b/y` headers, `+++ b/<path>` for the target name,
 * `@@` hunk headers to count +/- lines) — numstat semantics recovered from
 * the patch the host already ships, one RPC instead of three.
 *
 * `maxLines: 1` in the dispatch keeps the host from capping mid-file: the
 * cap formula (maxLines * 400 bytes) with maxLines clamped to its 20 floor
 * still bounds the payload, and a truncated patch just yields fewer exact
 * counts — the list stays complete because the header lines survive.
 */
interface HostGitShow {
	revision?: string;
	shortHash?: string;
	diff?: string;
	error?: string;
}

function adaptCommitFiles(host: HostGitShow): unknown {
	const files: Array<{
		path: string;
		previousPath?: string;
		changeType: string;
		insertions: number;
		deletions: number;
		isBinary: boolean;
	}> = [];
	const diff = host.diff ?? "";
	// Split on file headers. Rename detection in `diff-tree` output appears
	// as `similarity index`/`rename from`/`rename to` — previousPath comes
	// from `rename from`.
	const sections = diff.split(/^diff --git /m).slice(1);
	for (const section of sections) {
		// Target path: `+++ b/<path>` for text sections; binary sections carry
		// no `+++` line, so fall back to the section's leading `a/x b/y` header
		// (the split token removed the `diff --git ` prefix) post-image side.
		const pathMatch = /^\+\+\+ b\/(.+)$/m.exec(section);
		const headerMatch = /^a\/(.+?) b\/(.+)$/m.exec(section);
		const path = (pathMatch?.[1] ?? headerMatch?.[2])?.trim();
		if (!path) continue;
		const renameFrom = /^rename from (.+)$/m.exec(section);
		const binary = /^GIT binary patch/m.test(section) || /^Binary files /m.test(section);
		let insertions = 0;
		let deletions = 0;
		for (const line of section.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
			else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
		}
		const changeType = renameFrom
			? "R"
			: /^new file mode/m.test(section)
				? "A"
				: /^deleted file mode/m.test(section)
					? "D"
					: "M";
		files.push({
			path,
			...(renameFrom ? { previousPath: renameFrom[1].trim() } : {}),
			changeType,
			insertions,
			deletions,
			isBinary: binary,
		});
	}
	return { files };
}

/**
 * The sidebar's `commit.fileDiff` → this host's `git.show`. The sidebar
 * wants ONE file's diff as `{ original, modified, isBinary }` (original =
 * the pre-image text, modified = the post-image; the sidebar renders a
 * word-diff between them), while the host ships the whole commit's patch.
 * The adapter extracts the named file's section and splits the unified
 * patch back into pre/post images per hunk — lossless for unchanged and
 * changed lines alike, which is what the sidebar's diff view needs.
 */
function adaptCommitFileDiff(host: HostGitShow, payload: Record<string, unknown>): unknown {
	const filePath = typeof payload.path === "string" ? payload.path : "";
	const diff = host.diff ?? "";
	const sections = diff.split(/^diff --git /m).slice(1);
	// Section path: `+++ b/<path>` for text sections; binary sections carry
	// no `+++` line — fall back to the `diff --git a/x b/y` header (same
	// fallback adaptCommitFiles uses).
	const sectionPath = (s: string): string | undefined =>
		(/^\+\+\+ b\/(.+)$/m.exec(s)?.[1] ?? /^a\/(.+?) b\/(.+)$/m.exec(s)?.[2])?.trim();
	const section = sections.find(s => sectionPath(s) === filePath);
	if (!section) {
		// Not in this commit: empty sides — the sidebar renders "no diff"
		// rather than throwing.
		return { original: "", modified: "", isBinary: false };
	}
	if (/^GIT binary patch/m.test(section) || /^Binary files /m.test(section)) {
		return { original: "", modified: "", isBinary: true };
	}
	const originalLines: string[] = [];
	const modifiedLines: string[] = [];
	// The section's own metadata lines (leading `a/x b/y` header remnant,
	// `index`, `---`/`+++`, mode/rename lines) must not read as content: a
	// `--- a/x` line starts with `-` and would enter the pre-image. The
	// trailing newline the patch carries splits into a phantom empty last
	// line — trimmed before the walk.
	for (const [i, line] of section.replace(/\n$/, "").split("\n").entries()) {
		if (
			i === 0 ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("new file mode") ||
			line.startsWith("deleted file mode") ||
			line.startsWith("similarity index") ||
			line.startsWith("rename from") ||
			line.startsWith("rename to")
		) {
			continue;
		}
		if (line.startsWith("@@")) {
			// Hunk header — no content.
		} else if (line.startsWith("+")) {
			modifiedLines.push(line.slice(1));
		} else if (line.startsWith("-")) {
			originalLines.push(line.slice(1));
		} else {
			// Context line — both images.
			originalLines.push(line);
			modifiedLines.push(line);
		}
	}
	return { original: originalLines.join("\n"), modified: modifiedLines.join("\n"), isBinary: false };
}
