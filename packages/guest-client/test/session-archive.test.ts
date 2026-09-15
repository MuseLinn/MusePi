import { beforeEach, describe, expect, it } from "bun:test";
import {
	__resetSessionArchiveCacheForTests,
	archivedSessionIds,
	archiveSession,
	clearArchivedSessions,
	isSessionArchived,
	onArchivedSessionsChanged,
	readArchivedSessions,
	toggleArchivedSession,
	unarchiveSession,
	writeArchivedSessions,
} from "../src/lib/session-archive";

/** Notification is coalesced into a microtask — let it run. */
const tick = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 0));

/** Minimal localStorage + window so the module's DOM/storage guards are real. */
function installStorage(seed: Record<string, string> = {}) {
	const store = new Map(Object.entries(seed));
	const listeners = new Map<string, Set<() => void>>();
	const localStorage = {
		getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	};
	const window = {
		addEventListener: (name: string, fn: () => void) => {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)?.add(fn);
		},
		removeEventListener: (name: string, fn: () => void) => void listeners.get(name)?.delete(fn),
		dispatchEvent: (event: { type?: string }) => {
			for (const fn of listeners.get(String(event?.type)) ?? []) fn();
			return true;
		},
	};
	(globalThis as Record<string, unknown>).localStorage = localStorage;
	(globalThis as Record<string, unknown>).window = window;
	return { store, listeners };
}

const NEW_KEY = "musepi-sessions-archived";
const GUI_KEY = "musepi-gui-archived";
const COLLAB_KEY = "musepi-collab-archived";

beforeEach(() => {
	installStorage();
	__resetSessionArchiveCacheForTests();
});

describe("session archive: migration", () => {
	it("starts empty for a fresh install", () => {
		expect(readArchivedSessions()).toEqual([]);
	});

	it("migrates the desktop legacy shape ({sessionId, archivedAt, cwd})", () => {
		installStorage({
			[GUI_KEY]: JSON.stringify([
				{ sessionId: "s1", archivedAt: 1000, cwd: "/repo" },
				{ sessionId: "s2", archivedAt: 2000 },
			]),
		});
		__resetSessionArchiveCacheForTests();

		const migrated = readArchivedSessions();
		expect(migrated.map(e => e.sessionId).sort()).toEqual(["s1", "s2"]);
		expect(migrated.find(e => e.sessionId === "s1")).toEqual({ sessionId: "s1", archivedAt: 1000, cwd: "/repo" });
		// Written through to the new key so the next read is authoritative.
		expect(JSON.parse((globalThis.localStorage as Storage).getItem(NEW_KEY) as string)).toHaveLength(2);
	});

	it("migrates the guest legacy shape (bare id strings) as archivedAt 0", () => {
		installStorage({ [COLLAB_KEY]: JSON.stringify(["a", "b"]) });
		__resetSessionArchiveCacheForTests();

		expect(readArchivedSessions()).toEqual([
			{ sessionId: "a", archivedAt: 0 },
			{ sessionId: "b", archivedAt: 0 },
		]);
	});

	it("unions both legacy shapes and keeps the richer duplicate", () => {
		installStorage({
			[GUI_KEY]: JSON.stringify([{ sessionId: "shared", archivedAt: 5000, cwd: "/w" }]),
			[COLLAB_KEY]: JSON.stringify(["shared", "guest-only"]),
		});
		__resetSessionArchiveCacheForTests();

		const migrated = readArchivedSessions();
		expect(migrated).toHaveLength(2);
		expect(migrated.find(e => e.sessionId === "shared")).toEqual({
			sessionId: "shared",
			archivedAt: 5000,
			cwd: "/w",
		});
		expect(archivedSessionIds()).toEqual(new Set(["shared", "guest-only"]));
	});

	it("treats an existing new key as authoritative (legacy is not resurrected)", () => {
		installStorage({
			[NEW_KEY]: JSON.stringify([{ sessionId: "kept", archivedAt: 7 }]),
			[GUI_KEY]: JSON.stringify([{ sessionId: "stale", archivedAt: 1 }]),
		});
		__resetSessionArchiveCacheForTests();

		expect(readArchivedSessions().map(e => e.sessionId)).toEqual(["kept"]);
	});

	it("stops writing the legacy keys once migrated", () => {
		const { store } = installStorage({ [GUI_KEY]: JSON.stringify([{ sessionId: "old", archivedAt: 1 }]) });
		__resetSessionArchiveCacheForTests();
		archiveSession("fresh");
		expect(JSON.parse(store.get(GUI_KEY) as string)).toHaveLength(1);
		expect(store.has(COLLAB_KEY)).toBe(false);
		expect(
			JSON.parse(store.get(NEW_KEY) as string)
				.map((e: { sessionId: string }) => e.sessionId)
				.sort(),
		).toEqual(["fresh", "old"]);
	});

	it("survives malformed legacy payloads without throwing", () => {
		installStorage({ [GUI_KEY]: "{not json", [COLLAB_KEY]: JSON.stringify([42, null, ""]) });
		__resetSessionArchiveCacheForTests();
		expect(readArchivedSessions()).toEqual([]);
	});
});

describe("session archive: operations", () => {
	beforeEach(() => {
		installStorage();
		__resetSessionArchiveCacheForTests();
	});

	it("archives with cwd and is idempotent", () => {
		archiveSession("s1", "/repo");
		const first = readArchivedSessions();
		expect(first).toHaveLength(1);
		expect(first[0]?.cwd).toBe("/repo");
		expect(first[0]?.archivedAt).toBeGreaterThan(0);

		archiveSession("s1");
		expect(readArchivedSessions()).toHaveLength(1);
		// The original archivedAt/cwd survive a repeat archive.
		expect(readArchivedSessions()[0]?.cwd).toBe("/repo");
	});

	it("unarchives and toggles", () => {
		archiveSession("s1");
		expect(isSessionArchived("s1")).toBe(true);
		unarchiveSession("s1");
		expect(isSessionArchived("s1")).toBe(false);
		expect(readArchivedSessions()).toEqual([]);

		toggleArchivedSession("s2", "/w");
		expect(isSessionArchived("s2")).toBe(true);
		toggleArchivedSession("s2");
		expect(isSessionArchived("s2")).toBe(false);
	});

	it("writeArchivedSessions replaces the list wholesale and dedupes", () => {
		writeArchivedSessions([
			{ sessionId: "a", archivedAt: 1 },
			{ sessionId: "a", archivedAt: 9, cwd: "/newer" },
			{ sessionId: "b", archivedAt: 2 },
		]);
		const list = readArchivedSessions();
		expect(list.map(e => e.sessionId).sort()).toEqual(["a", "b"]);
		expect(list.find(e => e.sessionId === "a")).toEqual({ sessionId: "a", archivedAt: 9, cwd: "/newer" });
	});

	it("clearArchivedSessions empties the archive", () => {
		archiveSession("a");
		clearArchivedSessions();
		expect(readArchivedSessions()).toEqual([]);
	});

	it("notifies subscribers once per write and unsubscribes cleanly", async () => {
		let hits = 0;
		const off = onArchivedSessionsChanged(() => {
			hits += 1;
		});
		archiveSession("s1");
		await tick();
		// Three events are dispatched per write (canonical + both legacy names),
		// but a subscriber must observe exactly one notification.
		expect(hits).toBe(1);
		off();
		archiveSession("s2");
		await tick();
		expect(hits).toBe(1);
	});

	it("re-dispatches the legacy event names so unmigrated listeners update", () => {
		installStorage();
		__resetSessionArchiveCacheForTests();
		let legacyHits = 0;
		globalThis.window.addEventListener("musepi-gui-sessions-archived", () => {
			legacyHits += 1;
		});
		globalThis.window.addEventListener("musepi-gui-archived-changed", () => {
			legacyHits += 1;
		});
		archiveSession("s1");
		expect(legacyHits).toBe(2);
	});

	it("degrades to memory when storage is blocked", () => {
		const throwing = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		(globalThis as Record<string, unknown>).localStorage = throwing;
		__resetSessionArchiveCacheForTests();
		archiveSession("mem");
		expect(isSessionArchived("mem")).toBe(true);
	});
});
