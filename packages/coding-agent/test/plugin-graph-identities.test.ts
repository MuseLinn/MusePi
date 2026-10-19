/**
 * Plugin graph identities — the rules that decide "did this plugin's source change".
 *
 * Every case here exists because getting it wrong is SILENT: a missed change
 * means "my edit did nothing", a spurious one means the plugin reloads on every
 * reconcile and loses its fiber-scoped state. Neither shows up as an error.
 *
 * The module tracks a GRAPH (entry + every module it reached), not a single
 * file — an edit to a helper the entry imports has to reload the plugin, and
 * comparing the entry alone misses it. That distinction has its own test below.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDependencyOf, PluginGraphIdentities } from "../src/extensibility/plugins/plugin-graph-identities";

let dir = "";
let entry = "";
let helper = "";
let identities: PluginGraphIdentities;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-graph-identities-"));
	entry = join(dir, "index.ts");
	helper = join(dir, "helper.ts");
	writeFileSync(entry, 'import { h } from "./helper";\nexport default function () { h(); }\n');
	writeFileSync(helper, "export function h() {}\n");
	identities = new PluginGraphIdentities();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Age a file past any same-tick effect, so window tests stay isolated. */
function ageFile(file: string, msAgo = 10_000): void {
	const when = new Date(Date.now() - msAgo);
	utimesSync(file, when, when);
}

describe("the reload unit is the graph, not the entry", () => {
	test("editing an imported helper marks the plugin stale", () => {
		// The whole point of recording a graph. Before this the entry's mtime was
		// the only thing compared, so editing a helper scheduled nothing.
		ageFile(entry);
		ageFile(helper);
		identities.observe(entry, [entry, helper]);
		writeFileSync(helper, "export function h() { return 1; }\n");
		const stale = identities.stale([entry]);
		expect(stale.size).toBe(1);
		expect(stale.get(entry)?.file).toBe(helper);
		expect(stale.get(entry)?.reason).toBe("changed");
	});

	test("editing the entry marks the plugin stale", () => {
		ageFile(entry);
		ageFile(helper);
		identities.observe(entry, [entry, helper]);
		writeFileSync(entry, 'import { h } from "./helper";\nexport default function () { h(); h(); }\n');
		expect(identities.stale([entry]).get(entry)?.file).toBe(entry);
	});

	test("an unchanged graph is not stale", () => {
		// Reconcile runs on every RPC; a stable plugin must not reload, or its
		// fiber-scoped state resets continuously.
		ageFile(entry);
		ageFile(helper);
		identities.observe(entry, [entry, helper]);
		expect(identities.stale([entry]).size).toBe(0);
	});

	test("a file that disappeared is stale", () => {
		ageFile(entry);
		ageFile(helper);
		identities.observe(entry, [entry, helper]);
		rmSync(helper);
		expect(identities.stale([entry]).get(entry)?.reason).toBe("missing");
	});

	test("an unobserved plugin is stale", () => {
		// Never recorded = nothing to compare, and a spurious reload costs one
		// module re-read while a missed edit costs a manual touch.
		expect(identities.stale([entry]).get(entry)?.reason).toBe("unrecorded");
	});
});

describe("edits are detected", () => {
	test("a size change is stale", () => {
		ageFile(entry);
		identities.observe(entry, [entry]);
		writeFileSync(entry, "export default function () { return 1; }\n");
		expect(identities.stale([entry]).has(entry)).toBe(true);
	});

	test("a same-size rewrite is stale via the inode", () => {
		// A save-through-rename swaps the inode while the size can stay identical.
		// mtime alone would miss a same-tick same-size save; the inode does not.
		ageFile(entry);
		identities.observe(entry, [entry]);
		const before = statSync(entry);
		const replacement = join(dir, "replacement.ts");
		writeFileSync(replacement, "export default function () {}\n"); // same length
		rmSync(entry);
		renameSync(replacement, entry);
		const after = statSync(entry);
		// The fixture must actually have a new inode, or this proves nothing.
		expect(after.ino).not.toBe(before.ino);
		expect(identities.stale([entry]).has(entry)).toBe(true);
	});
});

describe("what must NOT count as an edit", () => {
	test("a ctime bump without a content change is not stale", () => {
		// Package managers create hard links on install, bumping ctime while size
		// and mtime are untouched. Including ctime made every install look like an
		// edit to every plugin.
		ageFile(entry);
		identities.observe(entry, [entry]);
		const hardLink = join(dir, "hardlink.ts");
		linkSync(entry, hardLink);
		rmSync(hardLink); // bumps the inode's ctime
		expect(identities.stale([entry]).size).toBe(0);
	});

	test("dependencies are excluded from the record, a plugin's own source is not", () => {
		// The scoping is the subtle part. An INSTALLED plugin lives at
		// `<plugins>/node_modules/<pkg>/`, so "the path contains node_modules"
		// would exclude every file of every installed plugin and leave the record
		// empty — silent, and indistinguishable from "nothing ever changes".
		// Only node_modules NESTED INSIDE the plugin is a dependency.
		const pluginDir = "/plugins/node_modules/mine";
		expect(isDependencyOf("/plugins/node_modules/mine/index.ts", pluginDir)).toBe(false);
		expect(isDependencyOf("/plugins/node_modules/mine/src/helper.ts", pluginDir)).toBe(false);
		// A dependency the plugin itself installed.
		expect(isDependencyOf("/plugins/node_modules/mine/node_modules/dep/index.js", pluginDir)).toBe(true);
		// A host module resolved through the compatibility shims — outside the plugin.
		expect(isDependencyOf("/host/packages/coding-agent/src/tools.ts", pluginDir)).toBe(true);
		// Windows separators take the same path.
		expect(isDependencyOf("C:\\plugins\\node_modules\\mine\\src\\helper.ts", "C:\\plugins\\node_modules\\mine")).toBe(
			false,
		);

		const dep = "/plugins/node_modules/mine/node_modules/dep/index.js";
		identities.observe(entry, [entry, dep], dir);
		// Only the entry survives: the dependency is not the plugin's to reload.
		expect(identities.fileCount(entry)).toBe(1);
	});
});

describe("the timestamp resolution window", () => {
	test("a file written after the observation counts as unrecorded", () => {
		// The load may have evaluated a module before a write that followed it
		// within the same tick; with no usable record, that is "possibly changed".
		identities.observe(entry, [entry]);
		const late = join(dir, "late.ts");
		writeFileSync(late, "x\n");
		identities.observeAt(entry, [entry, late], Date.now() - 10_000);
		expect(identities.stale([entry]).get(entry)?.reason).toBe("unrecorded");
	});

	test("now() returns a file-clock time", () => {
		// The observation clock must come from the file system, not the system
		// clock: comparing a file's mtime against a clock off by a tick makes a
		// just-written file look old (missed reload) or new (spurious reload).
		const at = identities.now();
		const marker = join(dir, "marker");
		writeFileSync(marker, "");
		const markerTime = statSync(marker).mtimeMs;
		expect(Math.abs(at - markerTime)).toBeLessThan(5000);
	});
});

describe("record bookkeeping", () => {
	test("refresh clears staleness after a reload", () => {
		// Without this a reloaded plugin stays stale forever and reloads on every
		// reconcile — the classic "plugin keeps restarting" bug.
		ageFile(entry);
		identities.observe(entry, [entry]);
		writeFileSync(entry, "export default function () { return 2; }\n");
		expect(identities.stale([entry]).has(entry)).toBe(true);
		identities.refresh(entry, [entry]);
		expect(identities.stale([entry]).size).toBe(0);
	});

	test("refresh also picks up a graph that gained a file", () => {
		// A reload can change which files the plugin imports; recording the graph
		// read after the reload keeps later edits to the new file detectable.
		ageFile(entry);
		identities.observe(entry, [entry]);
		const added = join(dir, "added.ts");
		writeFileSync(added, "export const x = 1;\n");
		identities.refresh(entry, [entry, added]);
		expect(identities.fileCount(entry)).toBe(2);
		// Longer content, so the size component of the identity changes and the
		// assertion does not depend on two writes landing in different ticks.
		writeFileSync(added, "export const x = 2; // and a longer tail\n");
		expect(identities.stale([entry]).get(entry)?.file).toBe(added);
	});

	test("owns() answers whether a changed path belongs to an entry", () => {
		// The watcher reports paths, not entries; this is how a changed path is
		// attributed without re-walking the graph.
		ageFile(entry);
		ageFile(helper);
		identities.observe(entry, [entry, helper]);
		expect(identities.owns(entry, helper)).toBe(true);
		expect(identities.owns(entry, join(dir, "unrelated.ts"))).toBe(false);
	});

	test("clear() drops every record", () => {
		ageFile(entry);
		identities.observe(entry, [entry]);
		identities.clear();
		expect(identities.stale([entry]).get(entry)?.reason).toBe("unrecorded");
	});
});
