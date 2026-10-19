/**
 * Disk identities of loaded plugin entry files — which one changed on disk.
 *
 * The daemon already watches the plugin roots, but a watcher event only says
 * "something under here moved". Deciding WHICH plugin to reload needs the
 * loaded file compared against what it was when it was evaluated, and that
 * comparison is subtle enough to get wrong in ways that are invisible until a
 * user reports "my edit did nothing".
 *
 * The rules below are taken from DSH's `packages/boot/hmr/src/module-files.ts`
 * rather than re-derived, because each one exists for a measured reason:
 *
 * 1. **Identity is `inode:size:mtime`, not mtime alone.** A same-size rewrite
 *    inside one timestamp tick is indistinguishable by mtime; the inode changes
 *    on a write-through (editors that write a temp file and rename) and the size
 *    changes on most real edits.
 * 2. **Change time is NOT part of the identity.** pnpm creates hard links from
 *    its store when installing, which bumps `ctime` without touching content —
 *    including `ctime` made a fresh install look like an edit and reload every
 *    plugin.
 * 3. **`TIMESTAMP_RESOLUTION_MS = 2000`.** FAT stores modification times in
 *    2-second units, so two writes in the same tick can share an `mtimeMs`. A
 *    file first observed within this window of the observation time is treated
 *    as possibly changed.
 * 4. **A file that disappeared is stale.** The loaded module no longer has a
 *    file behind it.
 * 5. **The observation clock is read from a marker file, not `Date.now()`.**
 *    The system clock and the file clock can differ by a tick in either
 *    direction; comparing a file's mtime against the wrong clock makes a
 *    just-written file look old (reload missed) or a just-installed file look
 *    new (spurious reload).
 * 6. **A module first seen after the last observation has no record.** It counts
 *    as stale when its file was modified at or after that observation (less the
 *    resolution window) — a reinstall between load and comparison is therefore
 *    detected, at the cost of reloading a module that was first loaded after
 *    such a write.
 *
 * The scope is narrower than DSH's: it tracks a plugin's ENTRY file, not its
 * whole import graph. The entry is what the loader keys module identity on, and
 * this host's reload re-evaluates the entry with a fresh cache-busting tag, so a
 * submodule edit is picked up by reloading the entry (see the HMR note in
 * `docs/plugin-tracks.md`).
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Coarsest file timestamp resolution among supported filesystems (FAT stores
 *  modification times in 2-second units). An unrecorded file modified within
 *  this interval before the last observation is treated as possibly changed. */
const TIMESTAMP_RESOLUTION_MS = 2000;

interface FileIdentity {
	/** Inode, size and modification time. */
	key: string;
	/** Modification time in epoch milliseconds. */
	modifiedAt: number;
}

/** Read a file's identity, or `undefined` when it is gone or unreadable. */
function identityOf(filePath: string): FileIdentity | undefined {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(filePath);
	} catch {
		// A removed or unreadable file no longer provides the loaded module.
		return undefined;
	}
	// `ino:size:mtime` — see rule 1. Rule 2 is the omission of `ctimeMs`.
	return {
		key: `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`,
		modifiedAt: stats.mtimeMs,
	};
}

/**
 * Records the identity of loaded plugin entry files and reports which changed.
 *
 * One instance per runtime; `observe` after a load, `compare` before deciding
 * what to reload, `refresh` after a reload has re-evaluated a file.
 */
export class PluginFileIdentities {
	/** Identity per recorded entry; `undefined` marks a stale entry (loaded after
	 *  the last observation, with no record of what it looked like then). */
	#records = new Map<string, string | undefined>();
	#observedAt = Date.now();

	/**
	 * The current time of the clock the operating system stamps local file
	 * writes with, read from a new marker file that is removed again (rule 5).
	 * The system clock and file timestamps can differ by a tick in either
	 * direction, so plugin files are compared with THIS time; when no marker can
	 * be created, the system clock is used.
	 */
	now(): number {
		let directory: string;
		try {
			directory = mkdtempSync(join(tmpdir(), "musepi-hmr-clock-"));
		} catch {
			// An unwritable temporary directory leaves the less precise system clock.
			return Date.now();
		}
		try {
			const marker = join(directory, "now");
			writeFileSync(marker, "");
			return statSync(marker).mtimeMs;
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	/**
	 * Compare loaded entry files with disk.
	 *
	 * @returns `stale`: the entries whose file changed or disappeared;
	 *          `seen`: the identity read for each compared entry (`undefined`
	 *          for a missing file), to hand back to {@link observe}.
	 */
	compare(entries: Iterable<string>): {
		stale: Set<string>;
		seen: Map<string, string | undefined>;
	} {
		const stale = new Set<string>();
		const seen = new Map<string, string | undefined>();
		for (const entry of entries) {
			const identity = identityOf(entry);
			seen.set(entry, identity?.key);
			if (identity === undefined) {
				// Rule 4: the file behind the loaded module is gone.
				stale.add(entry);
				continue;
			}
			if (
				this.#records.has(entry)
					? this.#records.get(entry) !== identity.key
					: // Rule 6: no record yet — treat a file written at or after the
						// last observation (less the resolution window) as changed.
						identity.modifiedAt >= this.#observedAt - TIMESTAMP_RESOLUTION_MS
			) {
				stale.add(entry);
			}
		}
		return { stale, seen };
	}

	/**
	 * Replace every record with the identities of the given loaded entries.
	 *
	 * @param options.seen identities read earlier by {@link compare}, so a later
	 *        write to an unchanged file stays detectable;
	 *        `options.retained` entries keep their previous record (or are marked
	 *        stale when they have none); `options.at` is the observation time
	 *        from {@link now} used for unrecorded entries.
	 */
	observe(
		entries: Iterable<string>,
		options: {
			seen?: ReadonlyMap<string, string | undefined>;
			retained?: ReadonlySet<string>;
			at?: number;
		} = {},
	): void {
		const { seen = new Map<string, string | undefined>(), retained = new Set<string>(), at = this.now() } = options;
		const records = new Map<string, string | undefined>();
		for (const entry of entries) {
			if (retained.has(entry)) records.set(entry, this.#records.get(entry));
			else if (seen.has(entry)) records.set(entry, seen.get(entry));
			else {
				// A module first loaded since `at` may have been evaluated before a
				// write that followed it. A write in the same file clock tick as `at`
				// counts as earlier, so files installed just before the comparison
				// are not reloaded.
				const identity = identityOf(entry);
				records.set(entry, identity === undefined || identity.modifiedAt > at ? undefined : identity.key);
			}
		}
		this.#records = records;
		this.#observedAt = at;
	}

	/**
	 * Record the current identity of entries just evaluated again, leaving every
	 * other record unchanged. Called after a reload so the plugin does not look
	 * stale again on the next comparison.
	 */
	refresh(entries: Iterable<string>): void {
		for (const entry of entries) this.#records.set(entry, identityOf(entry)?.key);
	}

	/** Drop all records (runtime dispose). */
	clear(): void {
		this.#records.clear();
	}
}
