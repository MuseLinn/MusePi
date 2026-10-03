import { head, repo, status } from "@musepi/pi-coding-agent";

/**
 * Repository state for one working directory.
 *
 * Everything here goes through the host's central git helper. A plugin that
 * shells out to `git` itself becomes a second implementation of timeouts,
 * output caps, reftable detection and Windows spawn handling — the helper
 * exists precisely so that does not happen, and the extension guide makes
 * hand-spawning a rule rather than a style preference.
 *
 * Ahead/behind is deliberately absent: `utils/git.ts` has no reader for it
 * (`rev-list` would have to be hand-assembled per direction, which is the
 * second-implementation problem above). Reporting branch, HEAD shape and
 * working-tree counts is the honest subset; adding tracking counts is a change
 * to the central helper, not to a plugin.
 */
export interface RepoState {
	/** False when `cwd` is not inside a repository at all. */
	inRepo: boolean;
	/** Repository root, when there is one. */
	root?: string;
	/** Branch name when HEAD is a ref. */
	branch?: string;
	/** True when HEAD points at a commit rather than a branch. */
	detached?: boolean;
	/** Short commit SHA, when HEAD resolves to one. */
	commit?: string;
	/** Working-tree counts; absent when status could not be read. */
	staged?: number;
	unstaged?: number;
	untracked?: number;
	/** Why the state is incomplete, when it is. */
	note?: string;
}

/** Read the state of the repository containing `cwd`. */
export async function readRepoState(cwd: string): Promise<RepoState> {
	const root = await repo.root(cwd).catch(() => null);
	if (!root) return { inRepo: false };

	const state: RepoState = { inRepo: true, root };

	// An unborn HEAD (fresh repo, no commits) resolves to null. That is still a
	// repository, so say so instead of reporting "not a repository".
	const resolved = await head.resolve(cwd).catch(() => null);
	if (!resolved) {
		state.note = "no commits yet";
		return state;
	}
	if (resolved.kind === "detached") {
		state.detached = true;
	} else {
		state.branch = resolved.branchName ?? resolved.ref;
	}
	if (resolved.commit) state.commit = resolved.commit.slice(0, 7);

	const counts = await status.summary(cwd).catch(() => null);
	if (counts) {
		state.staged = counts.staged;
		state.unstaged = counts.unstaged;
		state.untracked = counts.untracked;
	} else {
		state.note = "status unavailable";
	}

	return state;
}
