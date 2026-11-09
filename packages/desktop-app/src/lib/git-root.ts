/**
 * Cross-surface request to focus one workspace root in the changes panel.
 *
 * The session info card and the changes panel are separate surfaces; the card
 * may be the reason the git panel mounts at all, so the request is kept as a
 * one-shot value as well as an event. A mounted panel consumes the event; a
 * panel opening later consumes the pending value on mount.
 */
export const GIT_ROOT_EVENT = "musepi-gui-git-root";

let pendingRoot: string | null = null;

export function requestGitRoot(path: string): void {
	pendingRoot = path;
	window.dispatchEvent(new CustomEvent(GIT_ROOT_EVENT, { detail: path }));
}

export function consumeRequestedGitRoot(): string | null {
	const root = pendingRoot;
	pendingRoot = null;
	return root;
}
