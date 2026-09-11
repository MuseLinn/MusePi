import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { onGitPrefsChanged, readShowIgnored, writeShowIgnored } from "../src/lib/git-prefs";

/**
 * Shared git display pref (lib/git-prefs). Three surfaces read the same key
 * (Files pane, changes view, settings Git tab) — these tests pin the two
 * parts they depend on: the default, and the same-window change signal
 * (`storage` events do not fire in the window that wrote them, so the module
 * dispatches its own).
 *
 * The module needs `window` + `localStorage`; desktop-app tests run without a
 * DOM library, so this file installs a two-property shim and restores it.
 */
const store = new Map<string, string>();
const realm = globalThis as { window?: unknown; localStorage?: unknown };
const savedWindow = realm.window;
const savedLocalStorage = realm.localStorage;

beforeAll(() => {
	realm.window = new EventTarget();
	realm.localStorage = {
		getItem: (key: string): string | null => store.get(key) ?? null,
		setItem: (key: string, value: string): void => void store.set(key, String(value)),
		removeItem: (key: string): void => void store.delete(key),
	};
});

afterAll(() => {
	realm.window = savedWindow;
	realm.localStorage = savedLocalStorage;
});

beforeEach(() => store.clear());

describe("git display prefs", () => {
	test("gitignored paths are listed until the user explicitly turns them off", () => {
		expect(readShowIgnored()).toBe(true);
		writeShowIgnored(false);
		expect(readShowIgnored()).toBe(false);
		writeShowIgnored(true);
		expect(readShowIgnored()).toBe(true);
	});

	test("a write notifies subscribers, and unsubscribing stops the notifications", () => {
		let seen = 0;
		const off = onGitPrefsChanged(() => {
			seen++;
		});
		writeShowIgnored(false);
		expect(seen).toBe(1);
		off();
		writeShowIgnored(true);
		expect(seen).toBe(1);
	});
});
