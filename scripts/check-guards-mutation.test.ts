/**
 * `check-guards-mutation` contract tests.
 *
 * The runner's whole value is the honesty of its classification, so these cases
 * pin the distinction it exists to draw: a real assertion failure is a catch, a
 * timeout is UNPROVEN (the `expect(<DOM node>).toBeNull()` failure mode that
 * motivated the script), and a revert that no longer applies is an error rather
 * than a silent pass.
 */
import { describe, expect, test } from "bun:test";
import { applyRevert, classifyRun, parseMarkers } from "./check-guards-mutation";

describe("parseMarkers", () => {
	test("reads the revert target, line and replacement from a guard test", () => {
		const source = [
			'import { test } from "bun:test";',
			"",
			"// @guard: revert apps/desktop/src/styles/gui-chrome.css:869 | color: inherit;",
			"// @guard: test both cards' rows take the recipe's muted tone",
			'test("both cards rows", () => {});',
		].join("\n");
		const markers = parseMarkers("apps/desktop/test/hover-card-geometry.test.ts", source);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toEqual({
			file: "apps/desktop/test/hover-card-geometry.test.ts",
			markerLine: 3,
			target: "apps/desktop/src/styles/gui-chrome.css",
			line: 869,
			expected: "color: inherit;",
			replacement: "",
			testName: "both cards' rows take the recipe's muted tone",
		});
	});

	test("accepts an empty replacement as a line deletion", () => {
		// The catalog cache guard's defect IS the missing line, so the marker has
		// to be able to say "delete this" without inventing a replacement.
		const source = "// @guard: revert apps/desktop/src/components/ModelSelector.tsx:399 |";
		const markers = parseMarkers("x.test.tsx", source);
		expect(markers[0]?.replacement).toBe("");
		expect(markers[0]?.expected).toBe("");
	});

	test("carries several reverts in one file, each its own case", () => {
		const source = ["// @guard: revert a.css:1 | one", "// @guard: revert a.css:2 | two"].join("\n");
		expect(parseMarkers("g.test.ts", source).map(marker => marker.line)).toEqual([1, 2]);
	});

	test("does not read the convention's own prose as a marker", () => {
		// `.agents/rules/testing.md` and this script's doc block both describe the
		// syntax. A block-comment line without a real target must not match, or
		// the runner would try to revert documentation.
		const source = [
			" * Marker convention: `@guard: revert <path>:<line> | <replacement>`",
			" * A guard names the one-line revert that restores its defect.",
		].join("\n");
		expect(parseMarkers("doc.test.ts", source)).toEqual([]);
	});

	test("leaves a revert without a test name running the whole file", () => {
		expect(parseMarkers("g.test.ts", "// @guard: revert a.css:1 | one")[0]?.testName).toBeNull();
	});
});

describe("applyRevert", () => {
	const source = "a {\n\tcolor: var(--color-text-muted);\n}\n";

	test("replaces the named line and keeps its indentation", () => {
		const result = applyRevert(source, 2, "color: var(--color-text-muted);", "color: inherit;");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("a {\n\tcolor: inherit;\n}\n");
	});

	test("deletes the line when the replacement is empty", () => {
		const result = applyRevert("one\ntwo\nthree\n", 2, "two", "");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("one\nthree\n");
	});

	test("refuses when the line moved, naming what it found", () => {
		// The failure this prevents: a marker whose line drifted would revert a
		// DIFFERENT line, the suite would fail for the wrong reason, and the guard
		// would be reported caught while proving nothing.
		const result = applyRevert(source, 1, "color: var(--color-text-muted);", "color: inherit;");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("marker expects");
	});

	test("refuses a line outside the file", () => {
		const result = applyRevert(source, 99, "anything", "else");
		expect(result.ok).toBe(false);
	});

	test("refuses a revert that changes nothing", () => {
		const result = applyRevert(source, 2, "color: var(--color-text-muted);", "color: var(--color-text-muted);");
		expect(result.ok).toBe(false);
	});
});

describe("classifyRun", () => {
	test("a per-test failure is a catch", () => {
		const output = [
			"test\\panel-fold-reflow.test.ts:",
			"(pass) right panel fold > the subagent dock keeps its own exit [407.30ms]",
			"(fail) right panel fold > the panel's box holds [424.59ms]",
			" 2 pass",
			" 1 fail",
		].join("\n");
		const result = classifyRun(output, 1, false);
		expect(result.outcome).toBe("caught");
		expect(result.failedTests).toEqual(["right panel fold > the panel's box holds"]);
	});

	test("a timeout is unproven, never caught — the DOM-node reporter stall", () => {
		// `expect(<DOM node>).toBeNull()` makes Bun's reporter serialise the node
		// and stall: the suite prints "timed out after 5000ms" with no diff, so a
		// failing guard is indistinguishable from a slow one. Treating that as a
		// catch is precisely the false pass this script exists to remove.
		const output = [
			"(fail) failing toBeNull on a realistic rendered tree [69849.65ms]",
			"^ this test timed out after 5000ms.",
		].join("\n");
		const result = classifyRun(output, 0, true);
		expect(result.outcome).toBe("unproven");
		expect(result.detail).toContain("timed out");
	});

	test("a suite that passed on the reverted tree is unproven", () => {
		const result = classifyRun(" 3 pass\n 0 fail", 0, false);
		expect(result.outcome).toBe("unproven");
		expect(result.detail).toContain("did not restore the defect");
	});

	test("a harness failure is an error, not a catch", () => {
		// A module that will not resolve reddens the run without exercising any
		// assertion; counting it as a catch would "prove" a guard that never ran.
		const output = ["# Unhandled error between tests", "error: Cannot find module '@musepi/pi-utils'"].join("\n");
		const result = classifyRun(output, 1, false);
		expect(result.outcome).toBe("error");
		expect(result.detail).toContain("did not run");
	});
});
