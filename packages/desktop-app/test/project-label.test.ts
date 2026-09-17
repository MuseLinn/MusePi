import { describe, expect, test } from "bun:test";
import { pathBaseName, projectLabel, projectLabels } from "../src/lib/project-label";

/**
 * Issue #15 — two different folders named `demo` (e.g. `D:\a\demo` and
 * `D:\b\demo`) are two project spaces, but the sidebar showed them as two
 * identical "demo" blocks and the session import merged both sets of sessions
 * into one group named `demo`.
 *
 * Identity stays the full path everywhere; only the LABEL widens.
 */

describe("pathBaseName", () => {
	test("handles both separators", () => {
		expect(pathBaseName("D:\\a\\demo")).toBe("demo");
		expect(pathBaseName("/home/u/demo")).toBe("demo");
	});
});

describe("projectLabels", () => {
	test("unique basenames keep the plain basename", () => {
		const labels = projectLabels(["D:\\a\\alpha", "D:\\b\\beta"]);
		expect(labels.get("D:\\a\\alpha")).toBe("alpha");
		expect(labels.get("D:\\b\\beta")).toBe("beta");
	});

	test("colliding basenames get their parent segment", () => {
		// The report: two blocks both rendered as "demo".
		const labels = projectLabels(["D:\\a\\demo", "D:\\b\\demo"]);
		expect(labels.get("D:\\a\\demo")).toBe("a/demo");
		expect(labels.get("D:\\b\\demo")).toBe("b/demo");
	});

	test("collision widens only the colliding paths", () => {
		const labels = projectLabels(["D:\\a\\demo", "D:\\b\\demo", "D:\\c\\other"]);
		expect(labels.get("D:\\c\\other")).toBe("other");
		expect(labels.get("D:\\a\\demo")).toBe("a/demo");
	});

	test("colliding parents escalate to more segments", () => {
		// D:\a\x\demo and D:\b\x\demo agree on the parent too.
		const labels = projectLabels(["D:\\a\\x\\demo", "D:\\b\\x\\demo"]);
		expect(labels.get("D:\\a\\x\\demo")).toBe("a/x/demo");
		expect(labels.get("D:\\b\\x\\demo")).toBe("b/x/demo");
	});

	test("the same folder listed twice is one workspace, not a collision", () => {
		// A duplicate entry must not widen the label to the full path.
		const labels = projectLabels(["D:\\a\\demo", "D:\\a\\demo"]);
		expect(labels.get("D:\\a\\demo")).toBe("demo");
	});

	test("empty / single-segment paths degrade to something visible", () => {
		const labels = projectLabels(["demo", "D:\\other\\demo"]);
		expect(labels.get("demo")).toBeTruthy();
		expect(labels.get("D:\\other\\demo")).toBeTruthy();
		expect(labels.get("demo")).not.toBe(labels.get("D:\\other\\demo"));
	});
});

describe("projectLabel (single-row convenience)", () => {
	test("matches the batch result", () => {
		const all = ["D:\\a\\demo", "D:\\b\\demo", "D:\\c\\solo"];
		expect(projectLabel("D:\\a\\demo", all)).toBe("a/demo");
		expect(projectLabel("D:\\c\\solo", all)).toBe("solo");
	});

	test("falls back to the basename for an unknown path", () => {
		expect(projectLabel("D:\\z\\unknown", ["D:\\a\\demo"])).toBe("unknown");
	});
});
