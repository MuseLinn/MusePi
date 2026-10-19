import { describe, expect, it } from "bun:test";
import { hasPluginBlock, readPluginBlock } from "./manifest-block";

/**
 * The field a plugin declares itself under is read in several places — the
 * loader, the installer, the capability report, the plugin manager. They used
 * to disagree: the manager read only the two legacy spellings while every other
 * reader preferred the current one, so a package written against the current
 * field installed and loaded correctly but arrived from `list()` with no
 * manifest at all. `doctor` then reported it as "not a musepi plugin", and the
 * install-time extension check had nothing to validate.
 *
 * These cases pin the precedence and the shape rule so the two readers cannot
 * drift apart again.
 */
describe("readPluginBlock", () => {
	it("reads a plugin that declares only the current field", () => {
		// The regression: a package with no legacy field must still be a plugin.
		expect(readPluginBlock({ version: "1.0.0", musepi: { extensions: ["index.ts"] } })).toEqual({
			extensions: ["index.ts"],
		});
	});

	it("prefers the current field over a legacy one declaring something else", () => {
		// Both present and disagreeing: the current field wins, so a package that
		// declares the same plugin twice resolves to one answer everywhere.
		expect(
			readPluginBlock({ version: "1.0.0", musepi: { extensions: ["new.ts"] }, omp: { extensions: ["old.ts"] } }),
		).toEqual({ extensions: ["new.ts"] });
	});

	it("still reads a package that declares only a legacy field", () => {
		// An upstream-era package must keep working; this is the reason the two
		// legacy spellings are read at all.
		expect(readPluginBlock({ version: "1.0.0", omp: { extensions: ["legacy.ts"] } })).toEqual({
			extensions: ["legacy.ts"],
		});
		expect(readPluginBlock({ version: "1.0.0", pi: { extensions: ["older.ts"] } })).toEqual({
			extensions: ["older.ts"],
		});
	});

	it("falls through a malformed current field to a readable legacy one", () => {
		// `"musepi": true` is a typo, not a declaration. Returning it would hand
		// every reader a manifest whose fields all validate to nothing.
		expect(readPluginBlock({ version: "1.0.0", musepi: true, omp: { extensions: ["legacy.ts"] } })).toEqual({
			extensions: ["legacy.ts"],
		});
	});

	it("reports an ordinary npm dependency as declaring no plugin", () => {
		// A library installed into the plugins directory is not a plugin, and
		// doctor must be able to say so.
		expect(readPluginBlock({ version: "4.17.21", name: "lodash" })).toBeUndefined();
		expect(hasPluginBlock({ version: "4.17.21", name: "lodash" })).toBe(false);
		expect(hasPluginBlock({ version: "1.0.0", musepi: {} })).toBe(true);
	});

	it("reads nothing from a missing package", () => {
		// A package.json that could not be parsed reaches these readers as null.
		expect(readPluginBlock(null)).toBeUndefined();
		expect(readPluginBlock(undefined)).toBeUndefined();
	});
});
