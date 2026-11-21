import { afterAll, afterEach, describe, expect, test } from "bun:test";
import "./transcript-dom-shim";
import { FOLD_MAX_KEYS, readFoldStates, writeFoldStates } from "../src/components/transcript/Transcript";

/**
 * Round-fold open-state persistence.
 *
 * Contract: a round the reader closed (or opened) keeps that choice across a
 * session revisit AND across changes of the round's own default (running →
 * completed, deferred → history). The stored map is absolute open/closed, not
 * "differs from the default"; a legacy relative payload is migrated once.
 *
 * The failure modes still matter: a corrupt payload must not break rendering
 * (it is a preference, not state), and an unbounded map must not grow until
 * the write fails.
 */

// The module resolves `localStorage` at CALL time, so swapping the binding for
// the duration of this file is enough. It is restored in `afterAll`: a stub left
// on the global poisons later files in the same process that use the real one
// (the session-archive suite reads the same binding).
const realLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (key: string): string | null => store.get(key) ?? null,
		setItem: (key: string, value: string): void => void store.set(key, String(value)),
		removeItem: (key: string): void => void store.delete(key),
	},
});
afterAll(() => {
	if (realLocalStorage === undefined) {
		Reflect.deleteProperty(globalThis, "localStorage");
		return;
	}
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: realLocalStorage });
});

const SESSION = "session-abc";
const STORAGE_KEY = `musepi-transcript-folds:${SESSION}`;

afterEach(() => {
	store.clear();
});

describe("fold open-state persistence", () => {
	test("round-trips absolute open and closed states", () => {
		const states = new Map([
			["user-1", true],
			["user-2", false],
		]);
		writeFoldStates(SESSION, states);
		expect(readFoldStates(SESSION, false)).toEqual(states);
		expect(readFoldStates(SESSION, true)).toEqual(states);
	});

	test("an empty map clears the entry instead of storing a dead one", () => {
		writeFoldStates(SESSION, new Map([["user-1", false]]));
		writeFoldStates(SESSION, new Map());
		expect(readFoldStates(SESSION, false)).toEqual(new Map());
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	test("sessions are isolated from each other", () => {
		writeFoldStates("session-a", new Map([["a", true]]));
		writeFoldStates("session-b", new Map([["b", false]]));
		expect(readFoldStates("session-a", false)).toEqual(new Map([["a", true]]));
		expect(readFoldStates("session-b", false)).toEqual(new Map([["b", false]]));
	});

	test("a corrupt payload yields an empty map rather than throwing", () => {
		localStorage.setItem(STORAGE_KEY, "{not json");
		// A preference must never take the transcript down with it.
		expect(readFoldStates(SESSION, false)).toEqual(new Map());

		localStorage.setItem(STORAGE_KEY, JSON.stringify({ nope: "yes", ok: true, bad: 1 }));
		expect(readFoldStates(SESSION, false)).toEqual(new Map([["ok", true]]));

		localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
		expect(readFoldStates(SESSION, false)).toEqual(new Map());
	});

	test("migrates the legacy relative key list with the default in effect at load", () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(["user-1", "user-2"]));
		// A key meant "the opposite of the pre-preference default": collapsed
		// default → the reader had opened it.
		expect(readFoldStates(SESSION, false)).toEqual(
			new Map([
				["user-1", true],
				["user-2", true],
			]),
		);
		// The payload was rewritten as absolute states, so the next read is
		// independent of any default.
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({ "user-1": true, "user-2": true });
		expect(readFoldStates(SESSION, true)).toEqual(
			new Map([
				["user-1", true],
				["user-2", true],
			]),
		);
	});

	test("migrates a legacy payload written under the expanded default as closed", () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(["user-1"]));
		expect(readFoldStates(SESSION, true)).toEqual(new Map([["user-1", false]]));
		expect(readFoldStates(SESSION, false)).toEqual(new Map([["user-1", false]]));
	});

	test("keeps the newest states when the map is capped", () => {
		// A reader who opens every round of a long session must not lose the
		// toggle they just made to a cap.
		const many = new Map<string, boolean>();
		for (let i = 0; i < FOLD_MAX_KEYS + 50; i += 1) many.set(`user-${i}`, i % 2 === 0);
		writeFoldStates(SESSION, many);

		const back = readFoldStates(SESSION, false);
		expect(back.size).toBe(FOLD_MAX_KEYS);
		expect(back.get(`user-${FOLD_MAX_KEYS + 49}`)).toBe((FOLD_MAX_KEYS + 49) % 2 === 0);
		expect(back.has("user-0")).toBe(false);
	});
});
