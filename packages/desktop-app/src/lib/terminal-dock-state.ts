/**
 * Per-session memory of the bottom terminal dock's open state (app.tsx).
 *
 * The dock is one global surface, but its visibility follows the session
 * view: a session whose dock was never opened stays closed — and ChatView
 * then never mounts TerminalPanel, so no daemon pties spawn unprompted.
 * Each session id owns a bucket; a null session id (welcome / empty state)
 * shares the "" bucket so the dock stays toggleable there without leaking
 * into real sessions. In-memory only — every dock starts closed again on
 * relaunch.
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
