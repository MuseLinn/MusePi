/**
 * Archived sessions — single source of truth.
 *
 * History: the desktop GUI (`musepi-gui-archived`, an array of
 * `{sessionId, archivedAt, cwd?}`) and the guest/mobile shell
 * (`musepi-collab-archived`, a bare `string[]`) each kept their OWN archive in
 * localStorage. The two clients therefore showed two unrelated archives for the
 * same daemon, and clearing site data silently un-archived everything.
 *
 * This module unifies them:
 *   - one key (`musepi-sessions-archived`), one normalized shape;
 *   - one event (`musepi-sessions-archived-changed`), plus the two legacy event
 *     names re-dispatched so listeners that have not migrated keep updating;
 *   - a one-time READ migration that unions both legacy keys.
 *
 * Deliberate trade-offs:
 *   - The legacy keys are left ON DISK and simply stop being written. An older
 *     build still reads its own key and keeps working; deleting them would make
 *     that build show every session as un-archived. The cost is that an older
 *     build writing after the migration diverges until it is upgraded — merging
 *     legacy back in on every read would instead resurrect entries the user
 *     un-archived here, which is worse.
 *   - Storage is best-effort: private mode / blocked storage degrades to an
 *     in-memory list instead of throwing.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface ArchivedSession {
	sessionId: string;
	archivedAt: number;
	cwd?: string;
}

const ARCHIVE_KEY = "musepi-sessions-archived";
/** Read once for migration, never written again. */
const LEGACY_KEYS = ["musepi-gui-archived", "musepi-collab-archived"] as const;
export const SESSION_ARCHIVE_EVENT = "musepi-sessions-archived-changed";
/** Kept in sync so unmigrated listeners still refresh. */
const LEGACY_EVENTS = ["musepi-gui-sessions-archived", "musepi-gui-archived-changed"] as const;

const hasStorage = (): boolean => {
	try {
		return typeof globalThis.localStorage !== "undefined" && globalThis.localStorage !== null;
	} catch {
		return false;
	}
};

function readRaw(key: string): string | null {
	try {
		return globalThis.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeRaw(key: string, value: string): void {
	try {
		globalThis.localStorage.setItem(key, value);
	} catch {
		// private mode / quota — the in-memory list still drives this session
	}
}

function removeRaw(key: string): void {
	try {
		globalThis.localStorage.removeItem(key);
	} catch {
		// nothing to do
	}
}

/** Coerce one parsed entry (either legacy shape) into an ArchivedSession. */
function normalizeEntry(entry: unknown): ArchivedSession | null {
	if (typeof entry === "string") {
		return entry ? { sessionId: entry, archivedAt: 0 } : null;
	}
	if (!entry || typeof entry !== "object") return null;
	const record = entry as Record<string, unknown>;
	if (typeof record.sessionId !== "string" || !record.sessionId) return null;
	const archivedAt =
		typeof record.archivedAt === "number" && Number.isFinite(record.archivedAt) ? record.archivedAt : 0;
	const cwd = typeof record.cwd === "string" && record.cwd ? record.cwd : undefined;
	return { sessionId: record.sessionId, archivedAt, ...(cwd ? { cwd } : {}) };
}

function parseList(raw: string | null): ArchivedSession[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map(normalizeEntry).filter((entry): entry is ArchivedSession => entry !== null);
	} catch {
		return [];
	}
}

/** Dedupe by sessionId, newest archive time wins (legacy entries carry 0). */
function dedupe(list: ArchivedSession[]): ArchivedSession[] {
	const byId = new Map<string, ArchivedSession>();
	for (const entry of list) {
		const existing = byId.get(entry.sessionId);
		if (!existing) {
			byId.set(entry.sessionId, entry);
			continue;
		}
		const winner = entry.archivedAt >= existing.archivedAt ? entry : existing;
		const loser = winner === entry ? existing : entry;
		const cwd = winner.cwd ?? loser.cwd;
		byId.set(entry.sessionId, {
			sessionId: winner.sessionId,
			archivedAt: winner.archivedAt,
			...(cwd ? { cwd } : {}),
		});
	}
	return [...byId.values()];
}

let migrated = false;

/** In-memory mirror: the source of truth once localStorage is unavailable. */
let cache: ArchivedSession[] | null = null;

function load(): ArchivedSession[] {
	if (cache) return cache;
	if (!hasStorage()) {
		cache = [];
		return cache;
	}
	const stored = readRaw(ARCHIVE_KEY);
	if (stored !== null) {
		// New key present (even "[]"): it is authoritative, migration is done.
		migrated = true;
		cache = dedupe(parseList(stored));
		return cache;
	}
	// First run after the upgrade: union both legacy archives and adopt them.
	const union = dedupe(LEGACY_KEYS.flatMap(key => parseList(readRaw(key))));
	migrated = true;
	if (union.length > 0) writeRaw(ARCHIVE_KEY, JSON.stringify(union));
	cache = union;
	return cache;
}

function persist(list: ArchivedSession[]): void {
	cache = list;
	if (hasStorage()) writeRaw(ARCHIVE_KEY, JSON.stringify(list));
}

function notify(): void {
	const win = typeof globalThis.window === "undefined" ? null : globalThis.window;
	if (!win) return;
	for (const name of [SESSION_ARCHIVE_EVENT, ...LEGACY_EVENTS]) {
		try {
			win.dispatchEvent(new CustomEvent(name));
		} catch {
			// CustomEvent unavailable (non-DOM test env)
		}
	}
}

/** Every archived session, newest-archived last (call order is stable). */
export function readArchivedSessions(): ArchivedSession[] {
	return [...load()];
}

/** Replaces the archive wholesale (settings import / bulk edits). */
export function writeArchivedSessions(list: ArchivedSession[]): ArchivedSession[] {
	const next = dedupe(list.map(normalizeEntry).filter((e): e is ArchivedSession => e !== null));
	persist(next);
	notify();
	return [...next];
}

export function archivedSessionIds(): Set<string> {
	return new Set(load().map(entry => entry.sessionId));
}

export function isSessionArchived(sessionId: string): boolean {
	return load().some(entry => entry.sessionId === sessionId);
}

/** Archive a session. `cwd` is captured so the archive row can show the folder. */
export function archiveSession(sessionId: string, cwd?: string): ArchivedSession[] {
	const current = load();
	if (current.some(entry => entry.sessionId === sessionId)) return [...current];
	return writeArchivedSessions([...current, { sessionId, archivedAt: Date.now(), ...(cwd ? { cwd } : {}) }]);
}

export function unarchiveSession(sessionId: string): ArchivedSession[] {
	const current = load();
	if (!current.some(entry => entry.sessionId === sessionId)) return [...current];
	return writeArchivedSessions(current.filter(entry => entry.sessionId !== sessionId));
}

export function toggleArchivedSession(sessionId: string, cwd?: string): ArchivedSession[] {
	return isSessionArchived(sessionId) ? unarchiveSession(sessionId) : archiveSession(sessionId, cwd);
}

/** Subscribe to archive changes (this window's writes, other windows' storage
 *  events, and the legacy event names). Returns an unsubscribe function.
 *
 *  One write dispatches the canonical event plus both legacy names, and a
 *  subscriber listens to all three — so notifications are coalesced into a
 *  single microtask to avoid firing a listener three times per archive. */
export function onArchivedSessionsChanged(listener: () => void): () => void {
	const win = typeof globalThis.window === "undefined" ? null : globalThis.window;
	if (!win) return () => {};
	let scheduled = false;
	let off = false;
	const handler = (): void => {
		cache = null; // force a re-read: another window may have written
		if (scheduled || off) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			if (!off) listener();
		});
	};
	const names = [SESSION_ARCHIVE_EVENT, ...LEGACY_EVENTS];
	for (const name of names) win.addEventListener(name, handler);
	win.addEventListener("storage", handler);
	return () => {
		off = true;
		for (const name of names) win.removeEventListener(name, handler);
		win.removeEventListener("storage", handler);
	};
}

/**
 * React binding: `[archivedIds, { archive, unarchive, toggle }]`. Reads through
 * the shared store so the archive list follows every writer (header bulk
 * archive, sidebar row action, task-center cleanup) without a reload.
 */
export function useArchivedSessions(): {
	archived: ArchivedSession[];
	ids: Set<string>;
	archive: (sessionId: string, cwd?: string) => void;
	unarchive: (sessionId: string) => void;
	toggle: (sessionId: string, cwd?: string) => void;
	replace: (list: ArchivedSession[]) => void;
} {
	// Cache the snapshot object so concurrent renders do not churn identity.
	const snapshot = useSyncExternalStore(
		onArchivedSessionsChanged,
		() => JSON.stringify(readArchivedSessions()),
		() => JSON.stringify(readArchivedSessions()),
	);
	const archived = (() => {
		try {
			return JSON.parse(snapshot) as ArchivedSession[];
		} catch {
			return [];
		}
	})();
	const archive = useCallback((sessionId: string, cwd?: string) => void archiveSession(sessionId, cwd), []);
	const unarchive = useCallback((sessionId: string) => void unarchiveSession(sessionId), []);
	const toggle = useCallback((sessionId: string, cwd?: string) => void toggleArchivedSession(sessionId, cwd), []);
	const replace = useCallback((list: ArchivedSession[]) => void writeArchivedSessions(list), []);
	return {
		archived,
		ids: new Set(archived.map(entry => entry.sessionId)),
		archive,
		unarchive,
		toggle,
		replace,
	};
}

/** Test hook: drop the in-memory cache so a fresh localStorage is re-read. */
export function __resetSessionArchiveCacheForTests(): void {
	cache = null;
	migrated = false;
}

/** Test hook: has the one-time legacy migration run in this module instance? */
export function __sessionArchiveMigratedForTests(): boolean {
	return migrated;
}

/** Test/utility helper: drop the archive entirely. */
export function clearArchivedSessions(): void {
	cache = [];
	removeRaw(ARCHIVE_KEY);
	notify();
}
