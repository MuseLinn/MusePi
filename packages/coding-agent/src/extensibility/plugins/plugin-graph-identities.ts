/**
 * Disk identities of loaded plugin source graphs — which plugins changed on disk.
 *
 * Both plugin tracks record a snapshot of the files a plugin was evaluated from
 * and compare it later; this module owns the comparison rules so they exist
 * once. It works on a GRAPH (an entry plus every module its imports reached),
 * not on the entry alone: an edit to a helper file the entry imports must reload
 * the plugin, and comparing only the entry misses it.
 *
 * ## The rules, and why each one exists
 *
 * Every rule below is here because getting it wrong is silent — a missed change
 * reads as "my edit did nothing", a spurious one as "the plugin keeps losing its
 * state". Neither surfaces as an error.
 *
 * 1. **Identity is `inode:size:mtime`, not mtime alone.** A same-size rewrite
 *    inside one timestamp tick is indistinguishable by mtime; the inode changes
 *    when an editor saves through a temp file and rename, and the size changes on
 *    most real edits.
 * 2. **`ctime` is deliberately NOT part of the identity.** Package managers
 *    create hard links from their store on install, which bumps `ctime` without
 *    touching content — including it made every install look like an edit.
 * 3. **`TIMESTAMP_RESOLUTION_MS = 2000`.** FAT stores modification times in
 *    2-second units, so two writes in the same tick can share an `mtimeMs`. A
 *    file first observed inside this window of the observation time is treated as
 *    possibly changed. A spurious reload beats a missed edit.
 * 4. **A file that disappeared is stale.** The loaded module no longer has a file
 *    behind it.
 * 5. **The observation clock is read from a marker file, not `Date.now()`.** The
 *    system clock and the file clock can differ by a tick in either direction;
 *    comparing a file's mtime against the wrong clock makes a just-written file
 *    look old (reload missed) or a just-installed file look new (spurious reload).
 * 6. **A file first seen after the last observation has no record.** It counts as
 *    stale when it was modified at or after that observation (less the resolution
 *    window), so a reinstall between load and comparison is detected — at the
 *    cost of reloading a module first loaded after such a write.
 *
 * ## What this module does NOT decide
 *
 * Which plugins to reload is the caller's answer, from `stale()`: a graph is
 * stale when any of its files is. Dependents of a changed file are not walked
 * back up a global import graph — a plugin's own graph is the reload unit, and
 * the entry re-evaluation re-reads the whole graph anyway. Files under
 * `node_modules/` and `node:` builtins are excluded from the record: they belong
 * to the distribution (or the runtime), and reloading a plugin cannot change them.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
	// Rule 1; rule 2 is the deliberate omission of `ctimeMs`.
	return {
		key: `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`,
		modifiedAt: stats.mtimeMs,
	};
}

/**
 * Whether a file is a DEPENDENCY of a plugin rather than part of its own source.
 *
 * A dependency under `node_modules/` is replaced by reinstalling, not by editing
 * the plugin, and re-evaluating the plugin cannot pick up a change inside it.
 * Recording it would make every install look like every plugin changed.
 *
 * The test is scoped to the plugin's own directory, not to the path text: an
 * installed plugin lives at `<plugins>/node_modules/<pkg>/`, so "the path
 * contains node_modules" excludes every file of every installed plugin and
 * leaves the record empty — which reads as "nothing ever changes" rather than as
 * a bug. A file nested under the plugin's own `node_modules/` IS a dependency;
 * anything else under the plugin's directory is source.
 */
export function isDependencyOf(filePath: string, pluginDir: string): boolean {
	const normalizedFile = filePath.replaceAll("\\", "/");
	const normalizedDir = pluginDir.replaceAll("\\", "/").replace(/\/+$/, "");
	if (!normalizedFile.startsWith(`${normalizedDir}/`)) {
		// Not under this plugin at all — a host module resolved through the
		// compatibility shims, or a shared package. Not the plugin's to reload.
		return true;
	}
	const relative = normalizedFile.slice(normalizedDir.length + 1);
	// `relative` is the plugin-dir-relative path; a `node_modules/` segment inside
	// it means the plugin installed that dependency.
	return relative.startsWith("node_modules/") || relative.includes("/node_modules/");
}

/**
 * Records the source-graph identities of loaded plugins and reports which changed.
 *
 * One instance per runtime (or per session runner); call `observe` after a load,
 * `stale` before deciding what to reload, `refresh` after a reload re-evaluated
 * the files.
 */
export class PluginGraphIdentities {
	/** Per entry: the files it was evaluated from, and each file's identity. */
	#records = new Map<string, Map<string, string | undefined>>();

	/**
	 * The current time of the clock the operating system stamps local file writes
	 * with, read from a new marker file that is removed again (rule 5). When no
	 * marker can be created, the system clock is used.
	 */
	now(): number {
		let directory: string;
		try {
			directory = mkdtempSync(join(tmpdir(), "musepi-plugin-clock-"));
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
	 * Record what a plugin's files looked like as it was evaluated.
	 *
	 * @param entry the plugin's entry path (the record's key).
	 * @param files every file the load read, entry included.
	 * @param pluginDir the plugin's own root, used to tell its source from its
	 *        dependencies (see {@link isDependencyOf}). Defaults to the entry's
	 *        directory, which is right for a single-file plugin.
	 */
	observe(entry: string, files: Iterable<string>, pluginDir = dirname(entry)): void {
		const at = this.now();
		this.observeAt(entry, files, at, pluginDir);
	}

	/** {@link observe} with an explicit observation time, for a caller that
	 *  loaded several plugins under one clock reading. */
	observeAt(entry: string, files: Iterable<string>, at: number, pluginDir = dirname(entry)): void {
		const identities = new Map<string, string | undefined>();
		for (const file of files) {
			if (isDependencyOf(file, pluginDir)) continue;
			const identity = identityOf(file);
			// Rule 6: a file written after the observation counts as changed from
			// the start — `undefined` is the "no usable record" marker.
			identities.set(file, identity === undefined || identity.modifiedAt > at ? undefined : identity.key);
		}
		this.#records.set(entry, identities);
	}

	/**
	 * Record the current identity of files just re-evaluated, leaving every other
	 * record unchanged.
	 *
	 * Called after a reload: without it the plugin stays stale forever and
	 * reloads on every comparison — the classic "plugin restarts constantly" bug.
	 */
	refresh(entry: string, files: Iterable<string>, pluginDir = dirname(entry)): void {
		const identities = new Map<string, string | undefined>();
		for (const file of files) {
			if (isDependencyOf(file, pluginDir)) continue;
			identities.set(file, identityOf(file)?.key);
		}
		this.#records.set(entry, identities);
	}

	/**
	 * Which of these entries need a reload, and why.
	 *
	 * An entry is stale when any file in its recorded graph changed, disappeared,
	 * has no usable record, or (rule 4 continued) the entry was never observed.
	 * The `reason` is for the reload log: "entry changed" versus "a module it
	 * imports changed" are different edits and a bare boolean loses that.
	 */
	stale(entries: Iterable<string>): Map<string, { file: string; reason: "changed" | "missing" | "unrecorded" }> {
		const out = new Map<string, { file: string; reason: "changed" | "missing" | "unrecorded" }>();
		for (const entry of entries) {
			const recorded = this.#records.get(entry);
			if (recorded === undefined) {
				out.set(entry, { file: entry, reason: "unrecorded" });
				continue;
			}
			for (const [file, recordedKey] of recorded) {
				const identity = identityOf(file);
				if (identity === undefined) {
					out.set(entry, { file, reason: "missing" });
					break;
				}
				if (recordedKey === undefined) {
					out.set(entry, { file, reason: "unrecorded" });
					break;
				}
				if (identity.key !== recordedKey) {
					out.set(entry, { file, reason: "changed" });
					break;
				}
			}
		}
		return out;
	}

	/**
	 * Whether a file that just changed belongs to this entry's graph.
	 *
	 * The watcher reports paths, not entries. Answering "does this changed file
	 * matter to plugin X" from the record is cheaper and more accurate than
	 * re-walking the graph: the record IS the graph as it was loaded.
	 */
	owns(entry: string, filePath: string): boolean {
		return this.#records.get(entry)?.has(filePath) ?? false;
	}

	/** The number of files recorded for an entry (diagnostics and tests). */
	fileCount(entry: string): number {
		return this.#records.get(entry)?.size ?? 0;
	}

	/** Drop all records (runtime dispose). */
	clear(): void {
		this.#records.clear();
	}
}
