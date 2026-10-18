import { afterAll, afterEach, describe, expect, test } from "bun:test";
import "./transcript-dom-shim";
import { FOLD_MAX_KEYS, readFoldDeviations, writeFoldDeviations } from "../src/components/transcript/Transcript";

/**
 * Round-fold deviation persistence.
 *
 * Contract: which rounds a reader left open (or closed, when the default is
 * expanded) survive a session revisit, so a reading position restored inside an
 * open fold lands inside an open fold. Without it every fold reverts to the
 * default on the next visit.
 *
 * The two guards that matter are failure modes, not features: a corrupt payload
 * must not break rendering (it is a preference, not state), and an unbounded
 * key list must not grow until the write fails.
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

afterEach(() => {
	store.clear();
});

describe("fold deviation persistence", () => {
	test("round-trips deviations for a session", () => {
		const keys = new Set(["user-1", "user-2"]);
		writeFoldDeviations(SESSION, keys);
		expect(readFoldDeviations(SESSION)).toEqual(keys);
	});

	test("an empty set clears the entry instead of storing a dead one", () => {
		writeFoldDeviations(SESSION, new Set(["user-1"]));
		writeFoldDeviations(SESSION, new Set());
		// A stale `[]` would keep a per-session key alive forever and read as
		// "deviations existed".
		expect(readFoldDeviations(SESSION)).toEqual(new Set());
	});

	test("sessions are isolated from each other", () => {
		writeFoldDeviations("session-a", new Set(["a"]));
		writeFoldDeviations("session-b", new Set(["b"]));
		expect(readFoldDeviations("session-a")).toEqual(new Set(["a"]));
		expect(readFoldDeviations("session-b")).toEqual(new Set(["b"]));
	});

	test("a corrupt payload yields an empty set rather than throwing", () => {
		const key = `musepi-transcript-folds:${SESSION}`;
		localStorage.setItem(key, "{not json");
		// A preference must never take the transcript down with it.
		expect(readFoldDeviations(SESSION)).toEqual(new Set());

		localStorage.setItem(key, JSON.stringify({ nope: true }));
		expect(readFoldDeviations(SESSION)).toEqual(new Set());

		localStorage.setItem(key, JSON.stringify(["ok", 42, null]));
		expect(readFoldDeviations(SESSION)).toEqual(new Set(["ok"]));
	});

	test("keeps the newest deviations when the key list is capped", () => {
		// A reader who opens every round of a long session must not lose the
		// toggle they just made to a cap.
		const many = new Set<string>();
		for (let i = 0; i < FOLD_MAX_KEYS + 50; i += 1) many.add(`user-${i}`);
		writeFoldDeviations(SESSION, many);

		const back = readFoldDeviations(SESSION);
		expect(back.size).toBe(FOLD_MAX_KEYS);
		expect(back.has(`user-${FOLD_MAX_KEYS + 49}`)).toBe(true);
		expect(back.has("user-0")).toBe(false);
	});
});
