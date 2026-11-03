import { describe, expect, test } from "bun:test";
import {
	type ProfileGraphTarget,
	ProfileModuleGraph,
	type ProfileSourceGraph,
} from "../src/extensibility/plugins/hmr/profile-module-graph";

function target(entry: string, rowId = entry): ProfileGraphTarget {
	return { id: rowId, rowId, entry };
}

function graph(
	entry: string,
	dependencies: Record<string, string[]>,
	externals: Record<string, string[]> = {},
): ProfileSourceGraph {
	return {
		entry,
		dependencies: new Map(Object.entries(dependencies).map(([file, imports]) => [file, new Set(imports)])),
		externals: new Map(Object.entries(externals).map(([file, imports]) => [file, new Set(imports)])),
	};
}

describe("profile module graph propagation", () => {
	test("a changed leaf is accepted through every importer and reloads dependent rows as one plan", () => {
		const profiles = new ProfileModuleGraph();
		profiles.observe(
			target("/profile/a.ts"),
			graph("/profile/a.ts", {
				"/profile/a.ts": ["/shared/value.ts"],
				"/shared/value.ts": [],
			}),
		);
		profiles.observe(
			target("/profile/b.ts", "row-b"),
			graph("/profile/b.ts", {
				"/profile/b.ts": ["/shared/value.ts"],
				"/shared/value.ts": [],
			}),
		);
		profiles.observe(
			target("/profile/unrelated.ts"),
			graph("/profile/unrelated.ts", {
				"/profile/unrelated.ts": ["/profile/local.ts"],
				"/profile/local.ts": [],
			}),
		);

		const plan = profiles.plan(
			[target("/profile/a.ts"), target("/profile/b.ts", "row-b"), target("/profile/unrelated.ts")],
			["/shared/value.ts"],
		);

		expect([...plan.accepted]).toEqual(["/shared/value.ts", "/profile/a.ts", "/profile/b.ts"]);
		expect(plan.targets.map(item => item.rowId)).toEqual(["/profile/a.ts", "row-b"]);
		expect(plan.declined.has("/profile/unrelated.ts")).toBe(true);
		expect(plan.declined.has("/profile/local.ts")).toBe(true);
		expect(plan.pending).toEqual([]);
	});

	test("an entry-only edit does not reload an unrelated branch", () => {
		const profiles = new ProfileModuleGraph();
		profiles.observe(target("/profile/a.ts"), graph("/profile/a.ts", { "/profile/a.ts": [] }));
		profiles.observe(target("/profile/b.ts"), graph("/profile/b.ts", { "/profile/b.ts": [] }));

		const plan = profiles.plan([target("/profile/a.ts"), target("/profile/b.ts")], ["/profile/a.ts"]);

		expect(plan.targets.map(item => item.entry)).toEqual(["/profile/a.ts"]);
		expect(plan.declined.has("/profile/b.ts")).toBe(true);
	});

	test("host and package externals decline instead of becoming reload targets", () => {
		const profiles = new ProfileModuleGraph();
		const host = "/host/runtime.ts";
		const dependency = "/profile/node_modules/package/index.js";
		profiles.observe(
			target("/profile/a.ts"),
			graph(
				"/profile/a.ts",
				{ "/profile/a.ts": ["/profile/local.ts"], "/profile/local.ts": [] },
				{ "/profile/a.ts": [host], "/profile/local.ts": [dependency] },
			),
		);

		const plan = profiles.plan([target("/profile/a.ts")], [host, dependency]);

		expect(plan.targets).toEqual([]);
		expect(plan.accepted.size).toBe(0);
		expect(plan.declined.has(host)).toBe(true);
		expect(plan.declined.has(dependency)).toBe(true);
		expect(plan.pending.map(item => item.file)).toEqual([host, dependency]);
	});

	test("duplicate composition rows retain their row identities when they share an entry", () => {
		const profiles = new ProfileModuleGraph();
		profiles.observe(target("/profile/a.ts", "row-a"), graph("/profile/a.ts", { "/profile/a.ts": [] }));
		const rows = [target("/profile/a.ts", "row-a"), target("/profile/a.ts", "row-a-copy")];

		const plan = profiles.plan(rows, ["/profile/a.ts"]);

		expect(plan.targets.map(item => item.rowId)).toEqual(["row-a", "row-a-copy"]);
	});
});
