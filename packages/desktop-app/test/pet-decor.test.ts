import { describe, expect, test } from "bun:test";
import { PET_DECOR_DEFAULT, PET_DECOR_FLAGS, type PetDecor, petDecor, setPetDecorFlag } from "../src/lib/pet-decor";

/**
 * Decoration prefs (lib/pet-decor.ts). The module is small but it sits on a
 * real failure mode: the mascot's decoration is loaded from localStorage on
 * every render, so a garbled value must degrade to the defaults rather than
 * blank the orb. These tests pin the degradation rules and the flag table
 * the settings page is generated from.
 */

/** Minimal localStorage for the bun test runtime (no DOM here). */
function withStorage(seed: Record<string, string>): void {
	const map = new Map(Object.entries(seed));
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => map.set(k, v),
		removeItem: (k: string) => map.delete(k),
		clear: () => map.clear(),
		key: (i: number) => [...map.keys()][i] ?? null,
		get length() {
			return map.size;
		},
	};
}

describe("pet decor — storage degradation", () => {
	test("absent storage yields the defaults", () => {
		withStorage({});
		expect(petDecor()).toEqual(PET_DECOR_DEFAULT);
	});

	test("unparseable JSON yields the defaults instead of throwing", () => {
		// A truncated write (or a hand-edited devtools value) must not take
		// the mascot down — the settings page renders this on every paint.
		withStorage({ "musepi-gui-pet-decor": "{not json" });
		expect(petDecor()).toEqual(PET_DECOR_DEFAULT);
	});

	test("a non-object payload yields the defaults", () => {
		for (const raw of ["null", "42", '"gloss"', "[]"]) {
			withStorage({ "musepi-gui-pet-decor": raw });
			expect(petDecor()).toEqual(PET_DECOR_DEFAULT);
		}
	});

	test("one bad key degrades alone — the good keys survive", () => {
		// Key-by-key resolution is the point: a future flag written by a
		// newer build (or a junk type) must not reset the flags this build
		// does understand.
		withStorage({ "musepi-gui-pet-decor": JSON.stringify({ gloss: false, future: "junk" }) });
		expect(petDecor().gloss).toBe(false);

		withStorage({ "musepi-gui-pet-decor": JSON.stringify({ gloss: "yes" }) });
		expect(petDecor().gloss).toBe(PET_DECOR_DEFAULT.gloss);
	});

	test("unknown keys are dropped, not merged in", () => {
		withStorage({ "musepi-gui-pet-decor": JSON.stringify({ gloss: true, ghost: true }) });
		expect(Object.keys(petDecor())).toEqual(Object.keys(PET_DECOR_DEFAULT));
	});
});

describe("pet decor — writes", () => {
	test("setPetDecorFlag persists and round-trips through petDecor()", () => {
		withStorage({});
		setPetDecorFlag("gloss", false);
		expect(petDecor().gloss).toBe(false);
		// And back on.
		setPetDecorFlag("gloss", true);
		expect(petDecor().gloss).toBe(true);
	});

	test("a write keeps the other flags it did not touch", () => {
		withStorage({});
		// Writes are read-modify-write, so one flag turning off must not
		// silently reset its siblings to the defaults.
		setPetDecorFlag("gloss", false);
		const before = petDecor();
		setPetDecorFlag("gloss", false);
		expect(petDecor()).toEqual(before);
	});
});

describe("pet decor — flag table", () => {
	test("every flag names a real PetDecor key", () => {
		const keys = new Set<string>(Object.keys(PET_DECOR_DEFAULT));
		for (const flag of PET_DECOR_FLAGS) {
			expect(keys.has(flag.key)).toBe(true);
		}
	});

	test("every flag carries both i18n keys (the settings page has no fallback)", () => {
		// The section renders labelKey/descKey straight through t() — a
		// missing one would put a raw English key on a zh-CN page.
		for (const flag of PET_DECOR_FLAGS) {
			expect(flag.labelKey.length).toBeGreaterThan(0);
			expect(flag.descKey.length).toBeGreaterThan(0);
			expect(flag.labelKey).not.toBe(flag.descKey);
		}
	});

	test("no duplicate keys", () => {
		const seen = new Set<keyof PetDecor>();
		for (const flag of PET_DECOR_FLAGS) {
			expect(seen.has(flag.key)).toBe(false);
			seen.add(flag.key);
		}
	});

	test("the defaults are all booleans (the record is flag-only)", () => {
		for (const value of Object.values(PET_DECOR_DEFAULT)) {
			expect(typeof value).toBe("boolean");
		}
	});

	test("gloss is on by default — the shell must read as lit out of the box", () => {
		expect(PET_DECOR_DEFAULT.gloss).toBe(true);
	});
});
