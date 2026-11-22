/**
 * Contract test for the per-model threshold row helpers: one row's key/value
 * pair normalizes to the same persisted entry the settings file accepts
 * (`80%`, `f90000`, `400000`, `90k` → `90000`), and an invalid selector or
 * trigger is named instead of being saved.
 */
import { describe, expect, test } from "bun:test";
import {
	modelThresholdEntryText,
	modelThresholdKeyError,
	modelThresholdRows,
	normalizeModelThresholdRow,
	setModelThresholdRow,
} from "../../src/config/compaction-threshold-editor";

describe("compaction threshold rows", () => {
	test("reads persisted entries back as editor text", () => {
		expect(modelThresholdEntryText(90_000)).toBe("90000");
		expect(modelThresholdEntryText("80%")).toBe("80%");
		expect(modelThresholdEntryText("f90000")).toBe("f90000");
		expect(modelThresholdRows({ "acme/wide": 100_000, "openai/*": "80%", "x/y": null })).toEqual([
			{ key: "acme/wide", value: "100000" },
			{ key: "openai/*", value: "80%" },
		]);
	});

	test("accepts an exact selector or a trailing prefix", () => {
		expect(modelThresholdKeyError("acme/wide")).toBeUndefined();
		expect(modelThresholdKeyError("openrouter/anthropic/*")).toBeUndefined();
		expect(modelThresholdKeyError("acme")).toBeTruthy();
		expect(modelThresholdKeyError("acme/*/wide")).toBeTruthy();
		expect(modelThresholdKeyError("")).toBeTruthy();
	});

	test("normalizes a percentage, a suffixed count and a fixed trigger", () => {
		expect(normalizeModelThresholdRow("acme/wide", "80%")).toEqual({ entry: "80%" });
		expect(normalizeModelThresholdRow("acme/wide", "90k")).toEqual({ entry: 90_000 });
		expect(normalizeModelThresholdRow("acme/wide", "f90000")).toEqual({ entry: "f90000" });
		expect(normalizeModelThresholdRow("acme/wide", "f90k")).toEqual({ entry: "f90000" });
	});

	test("names the reason instead of saving a bad row", () => {
		const badKey = normalizeModelThresholdRow("nope", "80%");
		expect("error" in badKey && badKey.error).toContain("Invalid model selector");
		const badValue = normalizeModelThresholdRow("acme/wide", "abc");
		// The engine's own message names the accepted forms.
		expect("error" in badValue && badValue.error).toContain("Invalid compaction point");
		const empty = normalizeModelThresholdRow("acme/wide", "");
		expect("error" in empty && empty.error).toContain("value is required");
	});

	test("sets and clears one row without touching the others", () => {
		const base = { "acme/wide": "80%" as const };
		expect(setModelThresholdRow({ ...base }, "openai/*", 90_000)).toEqual({
			"acme/wide": "80%",
			"openai/*": 90_000,
		});
		expect(setModelThresholdRow({ ...base, "openai/*": 90_000 }, "acme/wide", null)).toEqual({ "openai/*": 90_000 });
	});
});
