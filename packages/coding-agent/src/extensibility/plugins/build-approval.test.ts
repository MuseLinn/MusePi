import { describe, expect, it } from "bun:test";
import { ensureTrustedField, parseBlockedBuilds, withApprovedBuilds } from "./build-approval";

/**
 * Build-script approval: parse bun's blocked-scripts report and manage the
 * `trustedDependencies` allowlist.
 *
 * The `WINDOWS_OUTPUT` fixture is the real `bun pm untrusted` text captured
 * from bun 1.4.2 on Windows (core-js 3.39.0 blocked after
 * `trustedDependencies: ["other-pkg"]` flipped the project to allowlist
 * mode); `POSIX_OUTPUT` is the same shape with forward slashes, a scoped
 * package, and duplicates.
 */
const WINDOWS_OUTPUT = [
	"",
	"bun pm untrusted v1.4.2 (744846f84)",
	"",
	".\\node_modules\\core-js @3.39.0",
	" » [postinstall]: node -e \"try{require('./postinstall')}catch(e){}\"",
	"",
	"These dependencies had their lifecycle scripts blocked during install.",
	"",
	"If you trust them and wish to run their scripts, use `bun pm trust`.",
	"",
].join("\n");

const POSIX_OUTPUT = [
	"./node_modules/@scope/pkg @1.0.0",
	" » [postinstall]: node ./install.js",
	"./node_modules/esbuild @0.21.5",
	" » [postinstall]: node install.js",
	"./node_modules/@scope/pkg @1.0.0",
	" » [postinstall]: node install.js",
	"some unrelated line",
	"",
].join("\n");

describe("parseBlockedBuilds", () => {
	it("reads the real Windows bun output", () => {
		expect(parseBlockedBuilds(WINDOWS_OUTPUT)).toEqual(["core-js"]);
	});

	it("reads scoped names, dedupes, and ignores noise", () => {
		expect(parseBlockedBuilds(POSIX_OUTPUT)).toEqual(["@scope/pkg", "esbuild"]);
	});

	it("returns empty for clean output", () => {
		expect(parseBlockedBuilds("")).toEqual([]);
		expect(parseBlockedBuilds("10 packages installed [3.57s]\n")).toEqual([]);
	});

	it("tolerates colorized output", () => {
		const colored = `[32m./node_modules/sharp @0.34.0[0m\n » [postinstall]: x`;
		expect(parseBlockedBuilds(colored)).toEqual(["sharp"]);
	});
});

describe("ensureTrustedField", () => {
	it("adds an empty allowlist when absent", () => {
		const pkg: Record<string, unknown> = { name: "musepi-plugins" };
		expect(ensureTrustedField(pkg)).toBe(true);
		expect(pkg.trustedDependencies).toEqual([]);
	});

	it("leaves a valid allowlist alone", () => {
		const pkg: Record<string, unknown> = { trustedDependencies: ["a"] };
		expect(ensureTrustedField(pkg)).toBe(false);
		expect(pkg.trustedDependencies).toEqual(["a"]);
	});

	it("repairs a malformed field to the valid entries", () => {
		const pkg: Record<string, unknown> = { trustedDependencies: ["a", 7, null] };
		expect(ensureTrustedField(pkg)).toBe(true);
		expect(pkg.trustedDependencies).toEqual(["a"]);
	});
});

describe("withApprovedBuilds", () => {
	it("merges approvals preserving order and skipping dupes", () => {
		const pkg: Record<string, unknown> = { trustedDependencies: ["a"] };
		expect(withApprovedBuilds(pkg, ["b", "a", " ", "c"])).toEqual(["b", "c"]);
		expect(pkg.trustedDependencies).toEqual(["a", "b", "c"]);
	});

	it("creates the field when absent", () => {
		const pkg: Record<string, unknown> = {};
		expect(withApprovedBuilds(pkg, ["a"])).toEqual(["a"]);
		expect(pkg.trustedDependencies).toEqual(["a"]);
	});
});
