/**
 * Per-session memory of the bottom terminal dock's open state (app.tsx).
 *
 * The dock is one global surface, and its VISIBILITY follows the session
 * view: a session whose dock was never opened shows it folded. Folding is
 * presentational only — once any session has opened the dock, ChatView
 * keeps TerminalPanel mounted (height 0 when folded), so the daemon ptys
 * and their scrollback survive session switches; a session that never
 * opens the dock never spawns one. Each session id owns a bucket; a null
 * session id (welcome / empty state) shares the "" bucket so the dock
 * stays toggleable there without leaking into real sessions. In-memory
 * only — every dock starts closed again on relaunch.
 */

export type DockOpens = ReadonlySet<string>;

/** Bucket key for a session id (null → the welcome / empty-state bucket). */
export function dockKey(sessionId: string | null): string {
	return sessionId ?? "";
}

export function isDockOpen(opens: DockOpens, sessionId: string | null): boolean {
	return opens.has(dockKey(sessionId));
}

/** Open/close the dock for one session. Returns the same set when nothing changes. */
export function setDockOpen(opens: DockOpens, sessionId: string | null, open: boolean): DockOpens {
	const key = dockKey(sessionId);
	if (opens.has(key) === open) return opens;
	const next = new Set(opens);
	if (open) next.add(key);
	else next.delete(key);
	return next;
}

/** Flip the dock for one session. */
export function toggleDockOpen(opens: DockOpens, sessionId: string | null): DockOpens {
	return setDockOpen(opens, sessionId, !isDockOpen(opens, sessionId));
}
