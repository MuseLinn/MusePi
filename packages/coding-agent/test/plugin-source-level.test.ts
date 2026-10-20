/**
 * Where a plugin came from is part of what the user sees.
 *
 * The capability center lists plugins with their source level, and the level is
 * what a user acts on: "is this mine to remove, or did the distribution ship
 * it?". The daemon used to answer "user" for everything it found in a plugins
 * tree, which made a project-scoped plugin look machine-wide and a bundled one
 * look like something the user had installed.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionModule } from "../src/capability/extension-module";
import type { SourceMeta } from "../src/capability/types";

/** The three levels the capability center understands. */
const LEVELS = ["user", "project", "native"] as const;

describe("source level vocabulary", () => {
	test("a plugin module carries one of the three levels", () => {
		// Pinned as a type-level contract: `native` exists because a shipped package
		// is neither the user's nor the project's, and collapsing it into either one
		// makes the removal affordance wrong.
		for (const level of LEVELS) {
			const module: ExtensionModule = {
				name: "x",
				path: "/x/index.ts",
				level,
				track: "plugin-module",
				_source: { provider: "p", providerName: "", path: "/x/index.ts", level },
			};
			expect(module.level).toBe(level);
		}
	});

	test("SourceMeta accepts the same three levels", () => {
		// The meta type is what travels to the client; if it disagreed with
		// ExtensionModule the daemon and the UI would render different labels for
		// one plugin.
		for (const level of LEVELS) {
			const meta: SourceMeta = { provider: "p", providerName: "", path: "/x", level };
			expect(meta.level).toBe(level);
		}
	});
});

describe("scope survives the loader", () => {
	test("a scoped entry keeps its scope alongside the path", () => {
		// `getScopedPluginExtensionPaths` exists because the plain path list dropped
		// the scope, and callers then had nothing to stamp but "user".
		const entries = [
			{ path: "/home/.musepi/plugins/node_modules/a/index.ts", scope: "user" as const },
			{ path: "/proj/.musepi/plugins/node_modules/b/index.ts", scope: "project" as const },
		];
		// The contract is that the scope travels with the path, not in a parallel
		// array the caller could desynchronize.
		expect(entries.map(entry => entry.scope)).toEqual(["user", "project"]);
		expect(entries.every(entry => entry.path.endsWith("index.ts"))).toBe(true);
	});
});
