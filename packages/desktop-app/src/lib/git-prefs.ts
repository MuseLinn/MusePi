/**
 * Git display preferences shared by every surface that shows working-tree
 * state: the right-pane changes view (git-panel), the settings Git tab, and
 * the Files pane's directory listing.
 *
 * One reader/writer per key so the surfaces cannot drift, plus a same-window
 * event because `storage` events do not fire in the window that wrote them
 * (the gitmoji pref already had to work around the same thing locally; this
 * centralises it).
 */

const SHOW_IGNORED_KEY = "musepi-gui-git-show-ignored";

/** Fired after any git pref changes; live consumers re-read on it. */
export const GIT_PREFS_EVENT = "omp-git-prefs-changed";

/**
 * Whether gitignored paths are listed. Defaults to ON: a tree that silently
 * drops `.gitignore`d entries reads as "my file is missing", and the entries
 * users reach for there (build output, `node_modules`, local env files) are
 * the ones they just touched. Only an explicit "0" (the user turned it off)
 * disables it, so the previous default does not resurrect itself.
 */
export function readShowIgnored(): boolean {
	try {
		return localStorage.getItem(SHOW_IGNORED_KEY) !== "0";
	} catch {
		return true;
	}
}

export function writeShowIgnored(value: boolean): void {
	try {
		localStorage.setItem(SHOW_IGNORED_KEY, value ? "1" : "0");
	} catch {
		// storage unavailable — the in-memory state still drives this render
	}
	window.dispatchEvent(new CustomEvent(GIT_PREFS_EVENT));
}

/** Subscribe to pref changes; returns the unsubscribe handle. */
export function onGitPrefsChanged(listener: () => void): () => void {
	window.addEventListener(GIT_PREFS_EVENT, listener);
	return () => window.removeEventListener(GIT_PREFS_EVENT, listener);
}
