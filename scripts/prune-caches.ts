#!/usr/bin/env bun
/**
 * Prune stale GitHub Actions cache entries (issue: cache quota).
 *
 * Why this exists: the repo's actions/cache quota is 10 GB, and this project's
 * caches are large — a single bazel disk-cache generation is ~1.15 GB and each
 * bun install cache ~0.6 GB. Once the quota is exceeded GitHub evicts by
 * last-access, which turns "did CI get a warm cache?" into a coin flip. The
 * worst offender found in practice was not growth but garbage: 4.68 GB (46% of
 * the quota) sat under the malformed ref `refs/heads/refs/tags/vX.Y.Z`, where
 * tag-scoped release caches land and where no main-branch job can ever restore
 * them.
 *
 * Pruning therefore targets three things, in this order:
 *   1. entries under an unreachable ref (a `refs/tags/...` path inside a
 *      branch ref) — never restorable, delete outright;
 *   2. a whole generation group on `refs/heads/main` that has not been touched
 *      for `--group-idle` days — dead weight, and the only rule that bounds the
 *      number of groups (each config-hash change creates a new one);
 *   3. superseded generations beyond the newest `--keep` in a group — the
 *      restore path picks the most recently created prefix match, so older
 *      ones can never win.
 *
 * Usage:
 *   bun scripts/prune-caches.ts                 # dry run, prints the plan
 *   bun scripts/prune-caches.ts --apply         # actually delete
 *   bun scripts/prune-caches.ts --apply --keep 2 --group-idle 30
 */

import { spawnSync } from "node:child_process";

export interface CacheEntry {
	id: number;
	key: string;
	ref: string;
	sizeInBytes: number;
	createdAt: string;
	lastAccessedAt: string;
}

export interface PruneDecision {
	entry: CacheEntry;
	reason: "unreachable-ref" | "group-idle" | "superseded";
	detail: string;
}

export interface PruneOptions {
	/** Reference time (epoch ms) — injected so the rules are testable. */
	now: number;
	/** Newest generations kept per group. */
	keepPerGroup?: number;
	/** Drop a whole group untouched for this many days (incl. its newest). */
	groupIdleDays?: number;
	/** Refs whose entries these rules manage. Everything else is left to
	 *  GitHub's own lifecycle (PR caches are dropped when the PR closes) —
	 *  except unreachable refs, which are always deleted. */
	managedRefs?: readonly string[];
	/** Key prefixes never group-expired (rarely-used release caches). */
	protectedKeyPrefixes?: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Group key = the cache key with its trailing hash segment removed, so
 * `bazel-disk-v3-linux-Linux-X64-<cfg>-<src>` groups by `<cfg>` (one group per
 * config generation, the unit that actually accumulates) and `bun-Linux-<hash>`
 * groups by `bun-Linux`. A key whose last segment is not hash-like is its own
 * group — unrelated keys must never collapse together.
 */
export function cacheGroupKey(key: string): string {
	const idx = key.lastIndexOf("-");
	if (idx <= 0) return key;
	const tail = key.slice(idx + 1);
	// 16+ chars of [A-Za-z0-9+/=_] reads as a digest; anything shorter is a
	// meaningful name segment (e.g. `-arm64`, `-win32`, `-baseline`).
	return tail.length >= 16 && /^[A-Za-z0-9+/=_-]+$/.test(tail) ? key.slice(0, idx) : key;
}

function isUnreachableRef(ref: string): boolean {
	// A tag ref recorded as a branch: `refs/heads/refs/tags/v1.2.3`. Restores
	// always address a real branch/PR ref, so these can never be hit.
	return ref.includes("/refs/tags/") || ref.startsWith("refs/tags/");
}

/**
 * Decide which entries to delete. Pure: no clock, no network — the caller
 * passes `now` and the entry list.
 */
export function planCachePrune(entries: readonly CacheEntry[], options: PruneOptions): PruneDecision[] {
	const keepPerGroup = options.keepPerGroup ?? 2;
	const groupIdleDays = options.groupIdleDays ?? 30;
	const managedRefs = new Set(options.managedRefs ?? ["refs/heads/main"]);
	const protectedPrefixes = options.protectedKeyPrefixes ?? ["bazel-disk-v3-release-"];

	const decisions: PruneDecision[] = [];
	const prunedIds = new Set<number>();

	// Rule 1 — unreachable ref, on any ref (nothing can restore it).
	for (const entry of entries) {
		if (!isUnreachableRef(entry.ref)) continue;
		decisions.push({ entry, reason: "unreachable-ref", detail: entry.ref });
		prunedIds.add(entry.id);
	}

	// Rules 2-3 manage only the refs we own; a PR's caches belong to GitHub's
	// PR lifecycle.
	const live = entries.filter(e => !prunedIds.has(e.id) && managedRefs.has(e.ref));
	const groups = new Map<string, CacheEntry[]>();
	for (const entry of live) {
		const group = cacheGroupKey(entry.key);
		const bucket = groups.get(group);
		if (bucket) bucket.push(entry);
		else groups.set(group, [entry]);
	}

	for (const [group, bucket] of groups) {
		// Newest first: the restore path resolves a prefix match to the most
		// recently created entry, so rank 0 is the one CI would actually use.
		const byAge = [...bucket].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
		const groupProtected = protectedPrefixes.some(p => group.startsWith(p));

		// Rule 2 — whole group idle. Skipped for protected groups so a cache
		// only used at release time is not expired between releases.
		if (!groupProtected) {
			const newest = byAge[0]!;
			const idleDays = (options.now - Date.parse(newest.lastAccessedAt)) / DAY_MS;
			if (Number.isFinite(idleDays) && idleDays > groupIdleDays) {
				for (const entry of byAge) {
					decisions.push({
						entry,
						reason: "group-idle",
						detail: `${Math.floor(idleDays)}d since last use (group ${group})`,
					});
					prunedIds.add(entry.id);
				}
				continue;
			}
		}

		// Rule 3 — superseded generations.
		for (const entry of byAge.slice(keepPerGroup)) {
			decisions.push({
				entry,
				reason: "superseded",
				detail: `rank >= ${keepPerGroup} in group ${group}`,
			});
			prunedIds.add(entry.id);
		}
	}

	return decisions;
}

function gh(args: readonly string[]): string {
	const res = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (res.status !== 0) {
		throw new Error(`gh ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
	}
	return res.stdout;
}

/** Read every cache entry (paginated) for a repo. */
export function listCaches(repo: string): CacheEntry[] {
	const out: CacheEntry[] = [];
	for (let page = 1; ; page++) {
		const raw = gh([
			"api",
			`repos/${repo}/actions/caches?per_page=100&page=${page}`,
			"--jq",
			".actions_caches[] | {id, key, ref, size_in_bytes, created_at, last_accessed_at}",
		]);
		const lines = raw.split("\n").filter(Boolean);
		if (lines.length === 0) break;
		for (const line of lines) {
			const r = JSON.parse(line) as Record<string, unknown>;
			out.push({
				id: Number(r.id),
				key: String(r.key),
				ref: String(r.ref),
				sizeInBytes: Number(r.size_in_bytes),
				createdAt: String(r.created_at),
				lastAccessedAt: String(r.last_accessed_at),
			});
		}
		if (lines.length < 100) break;
	}
	return out;
}

function fmtGb(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

function main(argv: readonly string[]): number {
	const apply = argv.includes("--apply");
	const num = (flag: string, fallback: number): number => {
		const i = argv.indexOf(flag);
		if (i === -1) return fallback;
		const raw = argv[i + 1];
		const parsed = raw === undefined ? Number.NaN : Number(raw);
		if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} needs a number`);
		return parsed;
	};

	const repoIdx = argv.indexOf("--repo");
	const repo = repoIdx === -1 ? "MuseLinn/MusePi" : (argv[repoIdx + 1] ?? "");
	if (!repo) throw new Error("--repo needs owner/name");

	const entries = listCaches(repo);
	const total = entries.reduce((n, e) => n + e.sizeInBytes, 0);
	const decisions = planCachePrune(entries, {
		now: Date.now(),
		keepPerGroup: num("--keep", 2),
		groupIdleDays: num("--group-idle", 30),
	});

	console.log(`${repo}: ${entries.length} cache entries, ${fmtGb(total)} total`);
	if (decisions.length === 0) {
		console.log("nothing to prune");
		return 0;
	}

	const freed = decisions.reduce((n, d) => n + d.entry.sizeInBytes, 0);
	const byReason = new Map<string, number>();
	for (const d of decisions) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
	console.log(
		`would delete ${decisions.length} entries (${fmtGb(freed)}): ` +
			[...byReason].map(([r, n]) => `${r}=${n}`).join(" "),
	);
	for (const d of decisions) {
		console.log(`  ${fmtGb(d.entry.sizeInBytes)}\t${d.reason}\t${d.detail}\t${d.entry.key.slice(0, 60)}`);
	}
	console.log(`after prune: ${fmtGb(total - freed)}`);

	if (!apply) {
		console.log("\ndry run — pass --apply to delete");
		return 0;
	}

	let deleted = 0;
	for (const d of decisions) {
		try {
			gh(["api", "-X", "DELETE", `repos/${repo}/actions/caches/${d.entry.id}`]);
			deleted += 1;
		} catch (error) {
			// One failure must not abort the sweep — report and continue.
			console.error(`  failed to delete ${d.entry.id}: ${error instanceof Error ? error.message : error}`);
		}
	}
	console.log(`deleted ${deleted}/${decisions.length} entries`);
	return deleted === decisions.length ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
}
