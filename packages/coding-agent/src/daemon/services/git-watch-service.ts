import * as path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { DaemonService } from "./types";

/**
 * GitWatchService — push `.git` changes to GUI clients.
 *
 * Capability seam:
 * - Input: `git.watch` / `git.unwatch` from a connection. Roots are refcounted
 *   per connection, so the changes panel and the session info card can watch
 *   the same repository without one unmounting the other's watcher.
 * - Output: `event.git.statusChanged` (global-event) with the roots sharing the
 *   changed git directory. The payload is intentionally only a hint: clients
 *   invalidate their status cache and re-read.
 * - Lifecycle: watchers exist only while at least one connection counts a
 *   root; `dropTarget`/`stop` close them. No polling.
 *
 * Scope: the git directory (HEAD, index, refs, worktrees) — the same surface
 * VS Code's `DotGitWatcher` covers. Working-tree edits are not watched here;
 * agent turns and window focus already bound that refresh, and a recursive
 * worktree watcher is a separate cost class.
 */

export interface GitWatchConnection {
	readonly id: string;
}

interface RepoWatch {
	gitDir: string;
	roots: Set<string>;
	watcher: FSWatcher;
	timer: ReturnType<typeof setTimeout> | null;
}

interface RootLookup {
	gitDir: string | null;
	at: number;
}

const REPO_MISS_TTL_MS = 60_000;
const DEBOUNCE_MS = 150;

export interface GitWatchServiceDeps {
	/** Global-event broadcast; the EventService owns the seq/envelope. */
	broadcast(payload: Record<string, unknown>): void;
}

export class GitWatchService implements DaemonService {
	readonly key = "gitWatch";
	readonly routes = {
		"git.watch": "watch",
		"git.unwatch": "unwatch",
	} as const;

	readonly #deps: GitWatchServiceDeps;
	/** connectionId → root → refcount */
	readonly #connections = new Map<string, Map<string, number>>();
	readonly #repos = new Map<string, RepoWatch>();
	readonly #roots = new Map<string, RootLookup>();
	readonly #resolving = new Map<string, Promise<string | null>>();
	#generation = 0;
	#stopped = false;

	constructor(deps: GitWatchServiceDeps) {
		this.#deps = deps;
	}

	watch(params: Record<string, unknown> | undefined, conn: GitWatchConnection): { roots: string[] } {
		const roots = normalizeRoots(params?.roots);
		const counts = this.#connections.get(conn.id) ?? new Map<string, number>();
		for (const root of roots) counts.set(root, (counts.get(root) ?? 0) + 1);
		this.#connections.set(conn.id, counts);
		void this.#sync();
		return { roots };
	}

	unwatch(params: Record<string, unknown> | undefined, conn: GitWatchConnection): { roots: string[] } {
		const roots = normalizeRoots(params?.roots);
		const counts = this.#connections.get(conn.id);
		if (counts) {
			for (const root of roots) {
				const next = (counts.get(root) ?? 0) - 1;
				if (next > 0) counts.set(root, next);
				else counts.delete(root);
			}
			if (counts.size === 0) this.#connections.delete(conn.id);
		}
		void this.#sync();
		return { roots };
	}

	dropTarget(connectionId: string): void {
		if (!this.#connections.delete(connectionId)) return;
		void this.#sync();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		for (const repo of this.#repos.values()) {
			if (repo.timer) clearTimeout(repo.timer);
			await repo.watcher.close();
		}
		this.#repos.clear();
		this.#connections.clear();
	}

	#activeRoots(): Set<string> {
		const active = new Set<string>();
		for (const counts of this.#connections.values()) {
			for (const [root, count] of counts) if (count > 0) active.add(root);
		}
		return active;
	}

	async #sync(): Promise<void> {
		if (this.#stopped) return;
		const generation = ++this.#generation;
		const active = this.#activeRoots();
		const mappings = await Promise.all(
			[...active].map(async root => ({
				root,
				gitDir: await this.#resolveGitDir(root).catch(() => null),
			})),
		);
		if (generation !== this.#generation) return;

		const byRepo = new Map<string, Set<string>>();
		for (const { root, gitDir } of mappings) {
			if (!gitDir) continue;
			const roots = byRepo.get(gitDir) ?? new Set<string>();
			roots.add(root);
			byRepo.set(gitDir, roots);
		}

		for (const [gitDir, roots] of byRepo) {
			const existing = this.#repos.get(gitDir);
			if (existing) {
				existing.roots = roots;
				continue;
			}
			try {
				this.#repos.set(gitDir, this.#startWatcher(gitDir, roots));
			} catch {
				// A repository removed between resolve and watch: skip it; the
				// next sync re-resolves from the connection refcounts.
			}
		}
		for (const [gitDir, repo] of this.#repos) {
			if (byRepo.has(gitDir)) continue;
			if (repo.timer) clearTimeout(repo.timer);
			await repo.watcher.close();
			this.#repos.delete(gitDir);
		}
	}

	async #resolveGitDir(root: string): Promise<string | null> {
		const cached = this.#roots.get(root);
		if (cached && (cached.gitDir !== null || Date.now() - cached.at < REPO_MISS_TTL_MS)) {
			return cached.gitDir;
		}
		const pending = this.#resolving.get(root);
		if (pending) return pending;
		const lookup = (async (): Promise<string | null> => {
			let proc: ReturnType<typeof Bun.spawn>;
			try {
				proc = Bun.spawn({
					cmd: ["git", "rev-parse", "--absolute-git-dir"],
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
				});
			} catch {
				this.#roots.set(root, { gitDir: null, at: Date.now() });
				return null;
			}
			const timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// already exited
				}
			}, 5_000);
			const [exitCode, stdout] = await Promise.all([
				proc.exited.catch(() => 1),
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			]);
			clearTimeout(timer);
			const gitDir = exitCode === 0 && stdout.trim().length > 0 ? path.resolve(stdout.trim()) : null;
			this.#roots.set(root, { gitDir, at: Date.now() });
			return gitDir;
		})();
		this.#resolving.set(root, lookup);
		try {
			return await lookup;
		} finally {
			this.#resolving.delete(root);
		}
	}

	#startWatcher(gitDir: string, roots: Set<string>): RepoWatch {
		const repo = { gitDir, roots, timer: null } as unknown as RepoWatch;
		const watcher = watch(gitDir, {
			ignoreInitial: true,
			persistent: false,
			followSymlinks: false,
			// HEAD/index/refs and worktree HEADs; index.lock and watchman
			// cookies churn without changing status.
			depth: 4,
			ignored: (candidate: string) => /(^|[\\/])(index\.lock|\.watchman-cookie-)/.test(candidate),
		});
		const changed = (): void => this.#schedule(repo);
		watcher.on("add", changed);
		watcher.on("change", changed);
		watcher.on("unlink", changed);
		watcher.on("error", () => {
			// A deleted repo or permission change: drop it and re-resolve from
			// the connection refcounts.
			this.#repos.delete(gitDir);
			void watcher.close();
			void this.#sync();
		});
		repo.watcher = watcher;
		return repo;
	}

	#schedule(repo: RepoWatch): void {
		if (repo.timer) clearTimeout(repo.timer);
		repo.timer = setTimeout(() => {
			repo.timer = null;
			const roots = [...repo.roots];
			if (roots.length === 0) return;
			this.#deps.broadcast({
				type: "git.statusChanged",
				roots,
				reason: "git-dir",
				at: Date.now(),
			});
		}, DEBOUNCE_MS);
	}
}

function normalizeRoots(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const roots = new Set<string>();
	for (const value of raw) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length === 0) continue;
		roots.add(path.resolve(trimmed));
	}
	return [...roots];
}
