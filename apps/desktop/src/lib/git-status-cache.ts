/**
 * Shared `git.status` cache for the GUI.
 *
 * Two surfaces read the same repository (the changes panel and the session
 * info card), and a session can expose several roots. Kimi's status cache uses
 * a TTL plus a single in-flight request per key; the same shape here keeps a
 * 15s poll from spawning one `git status` per directory and per surface.
 */

export interface GitFileStats {
	added: number;
	removed: number;
	binary: boolean;
}

export interface GitStatusFile {
	path: string;
	status: string;
}

export interface GitStatusView {
	root?: string;
	branch?: string | null;
	ahead?: number;
	behind?: number;
	staged?: GitStatusFile[];
	unstaged?: GitStatusFile[];
	untracked?: GitStatusFile[];
	ignored?: GitStatusFile[];
	added?: number;
	deleted?: number;
	fileStats?: {
		staged: Record<string, GitFileStats>;
		working: Record<string, GitFileStats>;
	};
	error?: string;
}

interface StatusRpc {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

const DEFAULT_TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: GitStatusView }>();
const inFlight = new Map<string, Promise<GitStatusView>>();
const STATUS_CHANGED_EVENT = "musepi-gui-git-status-changed";

/** A confirmed status-affecting mutation (stage/commit/…) or an explicit
 *  invalidation. The payload is the root, or undefined for "all roots". */
export function onGitStatusChanged(listener: (cwd?: string) => void): () => void {
	const handler = (event: Event): void => {
		const detail = (event as CustomEvent<string | null | undefined>).detail;
		listener(detail ?? undefined);
	};
	window.addEventListener(STATUS_CHANGED_EVENT, handler);
	return () => window.removeEventListener(STATUS_CHANGED_EVENT, handler);
}

function cacheKey(cwd: string, ignored: boolean): string {
	return `${cwd}\0${ignored ? "1" : "0"}`;
}

export async function readGitStatusCached(
	rpc: StatusRpc,
	cwd: string,
	options: { ignored?: boolean; ttlMs?: number; force?: boolean } = {},
): Promise<GitStatusView> {
	const ignored = options.ignored ?? false;
	const key = cacheKey(cwd, ignored);
	const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
	const hit = cache.get(key);
	if (!options.force && hit && Date.now() - hit.at < ttl) return hit.value;
	if (!options.force) {
		const pending = inFlight.get(key);
		if (pending) return pending;
	}
	const request = rpc
		.request<GitStatusView>("git.status", { cwd, ignored, numstat: true })
		.then(value => {
			cache.set(key, { at: Date.now(), value });
			return value;
		})
		.finally(() => {
			inFlight.delete(key);
		});
	inFlight.set(key, request);
	return request;
}

function forgetRoot(cwd: string): void {
	for (const key of cache.keys()) {
		if (key.startsWith(`${cwd}\0`)) cache.delete(key);
	}
}

/** Drop one root (after stage/commit/discard) or the whole cache. */
export function invalidateGitStatus(cwd?: string): void {
	if (cwd === undefined) cache.clear();
	else forgetRoot(cwd);
	window.dispatchEvent(new CustomEvent<string | undefined>(STATUS_CHANGED_EVENT, { detail: cwd }));
}

/** Daemon push: several roots can share one git directory, but consumers
 *  should reload once, not once per root. */
export function invalidateGitStatuses(roots: readonly string[]): void {
	if (roots.length === 0) {
		cache.clear();
	} else {
		for (const root of roots) forgetRoot(root);
	}
	window.dispatchEvent(
		new CustomEvent<string | undefined>(STATUS_CHANGED_EVENT, {
			// Several roots may share one git directory; "all" makes every
			// consumer reload once instead of one only matching the first root.
			detail: roots.length === 1 ? roots[0] : undefined,
		}),
	);
}
