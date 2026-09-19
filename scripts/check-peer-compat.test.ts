import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkRules, compareVersions, satisfiesCaret } from "../scripts/check-peer-compat";

/** Build a throwaway tree: <root>/<workspace>/node_modules/<pkg>/package.json */
function makeTree(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-compat-"));
	for (const [rel, version] of Object.entries(files)) {
		const dir = path.join(root, path.dirname(rel));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
	}
	return root;
}

describe("compareVersions", () => {
	test("orders numerically, not lexically", () => {
		// "19.10.0" < "19.9.0" under a string compare — the classic trap.
		expect(compareVersions("19.10.0", "19.9.0")).toBe(1);
		expect(compareVersions("19.9.0", "19.10.0")).toBe(-1);
	});

	test("treats a shorter version as zero-padded", () => {
		expect(compareVersions("19.2", "19.2.0")).toBe(0);
		expect(compareVersions("19.2.7", "19.2")).toBe(1);
	});

	test("ignores prerelease metadata", () => {
		expect(compareVersions("19.2.7-beta.1", "19.2.7")).toBe(0);
	});
});

describe("satisfiesCaret", () => {
	test("admits the floor and rejects below it", () => {
		expect(satisfiesCaret("19.3.0", "^19.3.0")).toBe(true);
		expect(satisfiesCaret("19.2.7", "^19.3.0")).toBe(false);
	});

	test("admits within the major, rejects the next major", () => {
		expect(satisfiesCaret("19.9.1", "^19.3.0")).toBe(true);
		expect(satisfiesCaret("20.0.0", "^19.3.0")).toBe(false);
	});
});

describe("checkRules — the blank-renderer regression (#e5ba4de17)", () => {
	test("flags react-konva newer than the pinned react", () => {
		const root = makeTree({
			"packages/desktop-app/node_modules/react-konva/package.json": "19.3.0",
			"packages/desktop-app/node_modules/react/package.json": "19.2.7",
		});
		const violations = checkRules(root);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.subjectVersion).toBe("19.3.0");
		expect(violations[0]?.peerVersion).toBe("19.2.7");
	});

	test("passes once react-konva is pinned to the matching line", () => {
		const root = makeTree({
			"packages/desktop-app/node_modules/react-konva/package.json": "19.2.7",
			"packages/desktop-app/node_modules/react/package.json": "19.2.7",
		});
		expect(checkRules(root)).toHaveLength(0);
	});

	test("skips the rule when a package is not installed", () => {
		// A partial install (or a checkout without desktop-app deps) must not
		// produce a false positive.
		const root = makeTree({
			"packages/desktop-app/node_modules/react/package.json": "19.2.7",
		});
		expect(checkRules(root)).toHaveLength(0);
	});

	test("the real repo tree currently passes", () => {
		expect(checkRules()).toHaveLength(0);
	});
});
