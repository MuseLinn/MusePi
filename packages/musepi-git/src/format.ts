import type { RepoState } from "./repo-state.ts";

/**
 * Render repo state as one status-bar line.
 *
 * Pure: takes a `RepoState`, returns a string. Kept separate from `readRepoState`
 * so the formatting is testable without a repository, and so a future status-bar
 * surface can reuse it verbatim.
 */
export function formatRepoState(state: RepoState): string {
	if (!state.inRepo) return "no repo";

	const parts: string[] = [];

	if (state.detached) {
		parts.push(`detached${state.commit ? `@${state.commit}` : ""}`);
	} else if (state.branch) {
		parts.push(state.branch);
	} else {
		parts.push("HEAD?");
	}

	// Only mention a counter when it is non-zero: a permanently-present "0"
	// trains the eye to skip the field, which is the opposite of what a status
	// line is for.
	if (state.staged) parts.push(`+${state.staged}`);
	if (state.unstaged) parts.push(`~${state.unstaged}`);
	if (state.untracked) parts.push(`?${state.untracked}`);

	if (state.note) parts.push(`(${state.note})`);

	return parts.join(" ");
}
