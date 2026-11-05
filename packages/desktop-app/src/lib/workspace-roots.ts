import { directoriesEqual } from "./workspace-projects";

/**
 * Selected file-panel root per session.
 *
 * A session can expose several working directories, and the files pane can
 * browse any of them. The choice is keyed by session id (falling back to the
 * primary directory when the host has no session), so switching sessions never
 * reuses another session's root, and a root the daemon later removes falls back
 * to the primary directory instead of leaving the pane pointed at nothing.
 */
type RootSelectionListener = (key: string, root: string | null) => void;

export interface RootSelectionStore {
	get(key: string): string | null;
	set(key: string, root: string | null): void;
	clear(): void;
	subscribe(listener: RootSelectionListener): () => void;
}

export function createRootSelectionStore(): RootSelectionStore {
	const selected = new Map<string, string>();
	const listeners = new Set<RootSelectionListener>();
	return {
		get(key) {
			return selected.get(key) ?? null;
		},
		set(key, root) {
			const current = selected.get(key) ?? null;
			if (root === null) {
				if (current === null) return;
				selected.delete(key);
			} else {
				if (current === root) return;
				selected.set(key, root);
			}
			for (const listener of listeners) listener(key, root);
		},
		clear() {
			if (selected.size === 0) return;
			const keys = [...selected.keys()];
			selected.clear();
			for (const key of keys) for (const listener of listeners) listener(key, null);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** One shared selection map for every file-pane mount in this renderer. */
export const fileRootSelection = createRootSelectionStore();

/** Identity for a root choice — a session switch must not inherit another one. */
export function rootSelectionKey(sessionId: string | null | undefined, cwd: string): string {
	return sessionId && sessionId.length > 0 ? `session:${sessionId}` : `cwd:${cwd}`;
}

/**
 * The selected root when it is still offered, otherwise the primary directory.
 * Comparison follows the daemon's separator/drive-case normalization so a
 * selection echoed back with different slashes still matches.
 */
export function resolveWorkspaceRoot(cwd: string, roots: readonly string[], selected: string | null): string {
	if (selected === null || selected.length === 0) return cwd;
	return roots.find(root => directoriesEqual(root, selected)) ?? cwd;
}
