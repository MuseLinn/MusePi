import * as path from "node:path";
import { type GitContextResult, readGitContext } from "../../git/context";
import type { DaemonService } from "./types";

/**
 * GitContextService — one normalized snapshot of a working directory's git
 * scene, for the future review panel.
 *
 * Capability seam:
 * - Input: `git.context` with an optional `cwd`, `base`, `maxFiles`, and
 *   `timeoutMs`. Every value is validated here; the computation itself is
 *   `src/git/context.ts` so it can be reused outside the daemon.
 * - Output: either the snapshot or a structured unavailable result
 *   (`not-a-repository` / `timeout` / `git-error` / `invalid-base`). Nothing
 *   throws for an ordinary "not a repository" answer.
 * - Lifecycle: stateless; no watcher, no cache. Read-only git probes only.
 */
export interface GitContextServiceDeps {
	/** Fallback working directory when a request omits `cwd`. */
	readonly cwd: () => string;
}

export class GitContextService implements DaemonService {
	readonly key = "gitContext";
	readonly routes = {
		"git.context": "context",
	} as const;

	readonly #deps: GitContextServiceDeps;

	constructor(deps: GitContextServiceDeps) {
		this.#deps = deps;
	}

	context(params?: Record<string, unknown>): Promise<GitContextResult> {
		const rawCwd = params?.cwd;
		const cwd = path.resolve(
			typeof rawCwd === "string" && rawCwd.trim().length > 0 ? rawCwd.trim() : this.#deps.cwd(),
		);
		return readGitContext(cwd, {
			base: typeof params?.base === "string" ? params.base : undefined,
			maxFiles: typeof params?.maxFiles === "number" ? params.maxFiles : undefined,
			timeoutMs: typeof params?.timeoutMs === "number" ? params.timeoutMs : undefined,
		});
	}
}
