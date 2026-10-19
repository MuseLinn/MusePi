/**
 * Plugin file identities — the rules that decide "did this plugin's file change".
 *
 * Every case here exists because getting it wrong is SILENT: a missed change
 * means "my edit did nothing", a spurious one means the plugin reloads on every
 * reconcile and loses its fiber-scoped state. Neither shows up as an error.
 *
 * The rules and the reasons are copied from DSH's HMR
 * (`packages/boot/hmr/src/module-files.ts`); each test names the failure it
 * defends against.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginFileIdentities } from "../src/extensibility/plugins/plugin-file-identities";

let dir = "";
let entry = "";
let identities: PluginFileIdentities;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-identities-"));
	entry = join(dir, "index.ts");
	writeFileSync(entry, "export default function () {}\n");
	identities = new PluginFileIdentities();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Make the file look older than any clock tick, so "same tick" effects are out
 *  of the picture unless a test is specifically about them. */
function ageFile(file: string, msAgo = 10_000): void {
	const when = new Date(Date.now() - msAgo);
	utimesSync(file, when, when);
}

describe("edits are detected", () => {
	test("a size change is stale", () => {
		// The ordinary edit: the file grew or shrank. `size` in the identity is
		// what catches it even when the write lands inside one mtime tick.
		identities.observe([entry]);
		writeFileSync(entry, "export default function () { return 1; }\n");
		expect(identities.compare([entry]).stale.has(entry)).toBe(true);
	});

	test("a same-size rewrite is stale via the inode", () => {
		// A write-then-rename editor (and any atomic save) swaps the inode while
		// content length can stay identical. mtime alone would miss a same-tick
		// same-size save; the inode does not.
		identities.observe([entry]);
		const before = statSync(entry);
		const replacement = join(dir, "replacement.ts");
		writeFileSync(replacement, "export default function () {}\n"); // same bytes
		rmSync(entry);
		// Simulate the rename that editors do: new inode, same content and size.
		const { renameSync } = require("node:fs") as typeof import("node:fs");
		renameSync(replacement, entry);
		const after = statSync(entry);
		// The fixture must actually have a new inode, or this proves nothing.
		expect(after.ino).not.toBe(before.ino);
		expect(identities.compare([entry]).stale.has(entry)).toBe(true);
	});

	test("an unchanged file is not stale", () => {
		// The other half: reconcile runs on every RPC, so a stable file must not
		// reload — that would reset fiber state continuously.
		ageFile(entry);
		identities.observe([entry]);
		expect(identities.compare([entry]).stale.size).toBe(0);
	});

	test("a deleted file is stale", () => {
		// The loaded module no longer has a file behind it.
		identities.observe([entry]);
		rmSync(entry);
		expect(identities.compare([entry]).stale.has(entry)).toBe(true);
	});
});

describe("what must NOT count as an edit", () => {
	test("a ctime bump without a content change is not stale", () => {
		// pnpm creates hard links from its store when installing; that bumps
		// ctime while size and mtime are untouched. Including ctime in the
		// identity made every install reload every plugin.
		identities.observe([entry]);
		const { linkSync, rmSync: rm } = require("node:fs") as typeof import("node:fs");
		const hardLink = join(dir, "hardlink.ts");
		linkSync(entry, hardLink);
		// Unlinking the extra link bumps the inode's ctime; identity must not care.
		rm(hardLink);
		expect(identities.compare([entry]).stale.size).toBe(0);
	});
});

describe("the timestamp resolution window", () => {
	test("a file first observed within the window counts as possibly changed", () => {
		// FAT stores mtime in 2-second units, so a file written in the same tick
		// as the observation can share its mtime. With no record yet, the safe
		// answer is "possibly changed" — a spurious reload beats a missed edit.
		const fresh = join(dir, "fresh.ts");
		writeFileSync(fresh, "x\n");
		// No observe() first: this file has no record.
		expect(identities.compare([fresh]).stale.has(fresh)).toBe(true);
	});

	test("a file first observed long before the observation is not stale", () => {
		// The same rule's other side: an old file with no record was installed
		// well before this runtime started, so it is not a pending change.
		const old = join(dir, "old.ts");
		writeFileSync(old, "x\n");
		ageFile(old, 60_000);
		identities.observe([entry]); // establishes observedAt = now
		expect(identities.compare([old]).stale.size).toBe(0);
	});
});

describe("record bookkeeping", () => {
	test("refresh clears staleness after a reload", () => {
		// Without this, a reloaded plugin stays stale forever and reloads on every
		// reconcile — the classic "plugin restarts constantly" bug.
		identities.observe([entry]);
		writeFileSync(entry, "export default function () { return 2; }\n");
		expect(identities.compare([entry]).stale.has(entry)).toBe(true);
		identities.refresh([entry]);
		expect(identities.compare([entry]).stale.size).toBe(0);
	});

	test("observe replaces the whole record set", () => {
		// `observe` is given the active set each time; a file dropped from it
		// loses its record and is treated as newly loaded on a later compare.
		const second = join(dir, "second.ts");
		writeFileSync(second, "x\n");
		ageFile(second);
		identities.observe([entry, second]);
		expect(identities.compare([entry, second]).stale.size).toBe(0);
		identities.observe([entry]); // `second` dropped from the active set
		expect(identities.compare([entry]).stale.size).toBe(0);
	});

	test("seen identities are reused so a later write stays detectable", () => {
		// `compare` returns the identities it read; handing them back lets the
		// caller record the state it actually compared against, rather than
		// re-reading (which could race a write that lands in between).
		identities.observe([entry]);
		const { seen } = identities.compare([entry]);
		identities.observe([entry], { seen });
		writeFileSync(entry, "export default function () { return 3; }\n");
		expect(identities.compare([entry]).stale.has(entry)).toBe(true);
	});

	test("now() returns a file-clock time", () => {
		// The observation clock must come from the file system, not the system
		// clock: comparing a file's mtime against a clock that is a tick off makes
		// a just-written file look old (missed reload) or new (spurious reload).
		const at = identities.now();
		const marker = join(dir, "marker");
		writeFileSync(marker, "");
		const markerTime = statSync(marker).mtimeMs;
		// Same clock source, so they agree to within a coarse tick.
		expect(Math.abs(at - markerTime)).toBeLessThan(5000);
	});
});
