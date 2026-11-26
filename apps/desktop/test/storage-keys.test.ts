import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import {
	readVersioned,
	readVersionedOneOf,
	type VersionedKey,
	writeVersioned,
} from "@musepi/client-core/src/lib/storage-keys";

/**
 * Versioned client-local storage: a rename must never lose a preference and
 * must never keep reading two places. Each case pins one half of that.
 */

const SPEC: VersionedKey = { key: "musepi.test.area.v1", legacy: ["omp-test-old", "omp-test-older"] };

afterEach(() => localStorage.clear());

describe("versioned storage keys", () => {
	test("reads the current key without touching legacy ones", () => {
		localStorage.setItem(SPEC.key, "current");
		localStorage.setItem("omp-test-old", "legacy");
		expect(readVersioned(SPEC)).toBe("current");
		// The legacy value is left alone when the current key already answers.
		expect(localStorage.getItem("omp-test-old")).toBe("legacy");
	});

	test("migrates the newest legacy spelling forward and removes every legacy key", () => {
		localStorage.setItem("omp-test-old", "value");
		localStorage.setItem("omp-test-older", "stale");
		expect(readVersioned(SPEC)).toBe("value");
		expect(localStorage.getItem(SPEC.key)).toBe("value");
		expect(localStorage.getItem("omp-test-old") === null).toBe(true);
		expect(localStorage.getItem("omp-test-older") === null).toBe(true);
	});

	test("newest legacy spelling wins over an older one", () => {
		localStorage.setItem("omp-test-old", "newer");
		localStorage.setItem("omp-test-older", "older");
		expect(readVersioned(SPEC)).toBe("newer");
	});

	test("returns null when neither spelling holds a value", () => {
		expect(readVersioned(SPEC) === null).toBe(true);
	});

	test("a write drops any legacy spelling still present", () => {
		localStorage.setItem("omp-test-old", "legacy");
		writeVersioned(SPEC, "next");
		expect(localStorage.getItem(SPEC.key)).toBe("next");
		expect(localStorage.getItem("omp-test-old") === null).toBe(true);
	});

	test("readVersionedOneOf rejects a value outside the allowed set", () => {
		localStorage.setItem(SPEC.key, "nope");
		expect(readVersionedOneOf(SPEC, ["a", "b"] as const) === null).toBe(true);
		localStorage.setItem(SPEC.key, "a");
		expect(readVersionedOneOf(SPEC, ["a", "b"] as const)).toBe("a");
	});
});
