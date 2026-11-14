/**
 * Plugin package ↔ extension-module attribution contract.
 *
 * A package row in the unified plugin list is the single list entry for a
 * plugin; the extension modules under its directory are collected into the
 * package detail dialog (included components + the plugin's own settings
 * surface). Attribution is decided by `isPathInside`.
 *
 * The two sides of that comparison are produced by different code paths —
 * `plugins.packages` builds a package directory with `path.join`, while
 * `extensions.list` returns each module's own entry path. On Windows the first
 * yields backslashes, and the old literal `startsWith(pkg.path + "/")`
 * comparison therefore never matched: third-party packages rendered as bare
 * rows with no components and no settings section, unlike the built-in units.
 *
 * These cases pin the behaviour that makes the two agree regardless of which
 * spelling either side hands over.
 */
import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { isPathInside } from "../src/components/UnifiedPluginsView";

describe("isPathInside (plugin package ↔ module attribution)", () => {
	it("matches when both sides use the same separator", () => {
		expect(isPathInside("/plugins/node_modules/demo/index.ts", "/plugins/node_modules/demo")).toBe(true);
	});

	it("matches a Windows package directory against a POSIX module path", () => {
		// pkg.path from path.join on Windows, module path preserved verbatim.
		expect(isPathInside("C:/plugins/node_modules/demo/index.ts", "C:\\plugins\\node_modules\\demo")).toBe(true);
	});

	it("matches a POSIX package directory against a Windows module path", () => {
		expect(isPathInside("C:\\plugins\\node_modules\\demo\\index.ts", "C:/plugins/node_modules/demo")).toBe(true);
	});

	it("is case-insensitive on Windows drive letters", () => {
		expect(isPathInside("c:\\plugins\\demo\\index.ts", "C:\\plugins\\demo")).toBe(true);
	});

	it("rejects a sibling directory that merely shares a prefix", () => {
		expect(isPathInside("/plugins/node_modules/demo-extra/index.ts", "/plugins/node_modules/demo")).toBe(false);
	});

	it("rejects a module outside the package directory", () => {
		expect(isPathInside("/plugins/node_modules/other/index.ts", "/plugins/node_modules/demo")).toBe(false);
	});

	it("rejects a parent directory", () => {
		expect(isPathInside("/plugins/node_modules", "/plugins/node_modules/demo")).toBe(false);
	});

	it("treats the directory itself as not inside itself", () => {
		expect(isPathInside("/plugins/node_modules/demo", "/plugins/node_modules/demo")).toBe(false);
	});

	it("matches the real musepi-auth-hub install shape (Windows pkg path + index.ts entry)", () => {
		// pkg.path from plugins.packages (path.join on Windows) and the module
		// entry path as extensions.list reports it for the same package.
		const pkgPath = "C:\\Users\\unive\\.musepi\\plugins\\node_modules\\musepi-auth-hub";
		const modulePath = `${pkgPath}/index.ts`;
		expect(isPathInside(modulePath, pkgPath)).toBe(true);
	});

	it("does not attribute a module from a different package", () => {
		const pkgPath = "C:\\plugins\\node_modules\\musepi-auth-hub";
		const other = "C:\\plugins\\node_modules\\other-plugin\\index.ts";
		expect(isPathInside(other, pkgPath)).toBe(false);
	});
});
