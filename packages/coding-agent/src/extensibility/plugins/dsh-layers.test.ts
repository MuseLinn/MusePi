/**
 * Layer-stack composition contract (DSH patch semantics).
 *
 * Reproduces `applyEntryPatches` from
 * `deepseek-harness/vendor/include/src/index.ts:57-127`: layers apply in
 * order, a patch addresses a row by id and replaces its config wholesale, and
 * an id that matches nothing is reported rather than guessed at.
 *
 * The behaviours pinned here are the ones a profile depends on: a bundle
 * inserts rows, a later layer reconfigures exactly one of them, and a typo in
 * a patch does not silently reconfigure the wrong row.
 */
import { describe, expect, it } from "bun:test";
import { composeDshLayers, type DshLayer } from "./dsh-layers";
import type { DshPatchRow } from "./dsh-patch";

function row(id: string, name: string, extra: Partial<DshPatchRow> = {}): DshPatchRow {
	return { id, name, disabled: undefined, config: undefined, inject: [], group: false, ...extra };
}

function layer(name: string, rows: DshPatchRow[]): DshLayer {
	return { name, rows };
}

describe("composeDshLayers", () => {
	it("inserts rows from every layer in application order", () => {
		const composed = composeDshLayers([
			layer("bundle-a", [row("alpha", "@scope/a"), row("beta", "@scope/b")]),
			layer("bundle-b", [row("gamma", "@scope/c")]),
		]);

		expect(composed.rows.map(r => r.id)).toEqual(["alpha", "beta", "gamma"]);
		expect(composed.rows[0]?.layers).toEqual(["bundle-a"]);
	});

	it("lets a later layer disable a row an earlier layer inserted", () => {
		const composed = composeDshLayers(
			[layer("bundle", [row("terminal-bash", "cordis:terminal/bash")])],
			[{ layer: "profile", override: { id: "terminal-bash", disabled: true } }],
		);

		expect(composed.rows).toHaveLength(1);
		expect(composed.rows[0]?.disabled).toBe(true);
		expect(composed.rows[0]?.layers).toEqual(["bundle", "profile"]);
	});

	it("replaces a row's config wholesale rather than deep-merging it", () => {
		// DSH replaces the whole config, which is what lets a profile REMOVE a
		// key a bundle set — a deep merge could not express that.
		const composed = composeDshLayers(
			[layer("bundle", [row("tool-x", "@scope/tool-x", { config: { retries: 3, timeout: 30 } })])],
			[{ layer: "profile", override: { id: "tool-x", config: { retries: 9 } } }],
		);

		expect(composed.rows[0]?.config).toEqual({ retries: 9 });
	});

	it("reports an override whose id matches no row instead of guessing", () => {
		const composed = composeDshLayers(
			[layer("bundle", [row("alpha", "@scope/a")])],
			[{ layer: "profile", override: { id: "typo", disabled: true } }],
		);

		expect(composed.unresolved).toEqual([{ id: "typo", layer: "profile" }]);
		// The real row is untouched — a typo must not disable the wrong plugin.
		expect(composed.rows[0]?.disabled).toBeUndefined();
	});

	it("skips an override whose name disagrees with the row it targets", () => {
		// The name check is DSH's: a patch written against a different row must
		// not reconfigure this one.
		const composed = composeDshLayers(
			[layer("bundle", [row("alpha", "@scope/alpha")])],
			[{ layer: "profile", override: { id: "alpha", name: "@scope/other", disabled: true } }],
		);

		expect(composed.unresolved).toEqual([{ id: "alpha", layer: "profile" }]);
		expect(composed.rows[0]?.disabled).toBeUndefined();
	});

	it("marks a row whose enabledness came from a !!js expression as conditional", () => {
		const composed = composeDshLayers([
			layer("bundle", [
				row("platform-row", "@scope/p", { disabled: { kind: "js-expr", expr: "process.platform === 'win32'" } }),
			]),
		]);

		expect(composed.rows[0]?.disabled).toBeUndefined();
		expect(composed.conditionalRows).toEqual(["platform-row"]);
	});

	it("keeps a later layer's boolean disabled over an earlier expression", () => {
		const composed = composeDshLayers(
			[layer("bundle", [row("alpha", "@scope/a", { disabled: { kind: "js-expr", expr: "ctx.flag" } })])],
			[{ layer: "profile", override: { id: "alpha", disabled: false } }],
		);

		expect(composed.rows[0]?.disabled).toBe(false);
	});

	it("lets a later layer address a row the SAME layer inserted", () => {
		// The index is rebuilt as rows are added, so a later patch in one file
		// can configure what an earlier patch in that file inserted.
		const composed = composeDshLayers(
			[layer("bundle", [row("alpha", "@scope/a"), row("beta", "@scope/b")])],
			[{ layer: "bundle", override: { id: "alpha", disabled: true } }],
		);

		expect(composed.rows[0]?.disabled).toBe(true);
	});
});
