/**
 * Tests for the cache-prune planner.
 *
 * The rules decide what gets DELETED, so the failure modes worth pinning are
 * the destructive ones: pruning an entry CI still needs (the newest generation
 * of a group, a rarely-used release cache, anything on main that is actually
 * current) and, conversely, never pruning the known garbage (tag-scoped caches
 * stranded on a malformed branch ref) that pushed the repo over quota.
 */

import { describe, expect, it } from "bun:test";
import { type CacheEntry, cacheGroupKey, planCachePrune } from "./prune-caches";

const NOW = Date.parse("2026-09-17T12:00:00Z");
/** Real cache keys carry 64-hex digests; short synthetic ones would read as
 *  name segments to `cacheGroupKey` and group differently. */
const H = (seed: string): string => seed.padEnd(64, "0");
const daysAgo = (n: number): string => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function entry(over: Partial<CacheEntry> & { id: number; key: string }): CacheEntry {
	return {
		ref: "refs/heads/main",
		sizeInBytes: 1024 ** 3,
		createdAt: daysAgo(1),
		lastAccessedAt: daysAgo(1),
		...over,
	};
}

const plan = (entries: CacheEntry[], over: Partial<Parameters<typeof planCachePrune>[1]> = {}) =>
	planCachePrune(entries, { now: NOW, ...over });
const ids = (d: ReturnType<typeof planCachePrune>) => d.map(x => x.entry.id).sort((a, b) => a - b);

describe("cacheGroupKey", () => {
	it("groups bazel disk generations by config hash", () => {
		const a = cacheGroupKey(`bazel-disk-v3-linux-Linux-X64-${H("aa3f")}-${H("11b2")}`);
		const b = cacheGroupKey(`bazel-disk-v3-linux-Linux-X64-${H("aa3f")}-${H("22c3")}`);
		expect(a).toBe(`bazel-disk-v3-linux-Linux-X64-${H("aa3f")}`);
		expect(a).toBe(b);
	});

	it("separates different config hashes (different groups)", () => {
		expect(cacheGroupKey(`bazel-disk-v3-linux-Linux-X64-${H("aa3f")}-${H("11b2")}`)).not.toBe(
			cacheGroupKey(`bazel-disk-v3-linux-Linux-X64-${H("bb4e")}-${H("11b2")}`),
		);
	});

	it("groups bun caches by platform, not by lockfile hash", () => {
		expect(cacheGroupKey("bun-Linux-4cffda71722af5752195cdf9")).toBe("bun-Linux");
	});

	it("keeps short trailing segments (they are names, not hashes)", () => {
		expect(cacheGroupKey("bazel-disk-v3-release-darwin-arm64")).toBe("bazel-disk-v3-release-darwin-arm64");
	});
});

describe("planCachePrune: unreachable refs", () => {
	it("deletes caches stranded on a tag-ref-shaped branch ref", () => {
		// The real 4.68 GB incident: tag-scoped release caches land on
		// `refs/heads/refs/tags/vX.Y.Z`, unreachable from any main-branch job.
		const d = plan([entry({ id: 1, key: `bun-Linux-${H("97da")}`, ref: "refs/heads/refs/tags/v0.4.30" })]);
		expect(ids(d)).toEqual([1]);
		expect(d[0]?.reason).toBe("unreachable-ref");
	});

	it("leaves real PR refs alone", () => {
		expect(plan([entry({ id: 1, key: `bun-Linux-${H("97da")}`, ref: "refs/pull/42/merge" })])).toEqual([]);
	});
});

describe("planCachePrune: superseded generations", () => {
	it("keeps the newest N of a group and deletes the rest", () => {
		const d = plan([
			entry({ id: 1, key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("31d4")}`, createdAt: daysAgo(9) }),
			entry({ id: 2, key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("42e5")}`, createdAt: daysAgo(5) }),
			entry({ id: 3, key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("53f6")}`, createdAt: daysAgo(1) }),
		]);
		// Newest two survive; only rank 3 goes.
		expect(ids(d)).toEqual([1]);
		expect(d[0]?.reason).toBe("superseded");
	});

	it("honours --keep", () => {
		const entries = [
			entry({ id: 1, key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("31d4")}`, createdAt: daysAgo(9) }),
			entry({ id: 2, key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("42e5")}`, createdAt: daysAgo(5) }),
			entry({ id: 3, key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("53f6")}`, createdAt: daysAgo(1) }),
		];
		expect(ids(plan(entries, { keepPerGroup: 1 }))).toEqual([1, 2]);
	});

	it("never touches a group of size <= keep", () => {
		const d = plan([
			entry({ id: 1, key: `bazel-disk-v3-natives-win32-Linux-X64-${H("ee7c")}-${H("75b8")}` }),
			entry({ id: 2, key: `bazel-disk-v3-natives-win32-Linux-X64-${H("ee7c")}-${H("86c9")}` }),
		]);
		expect(d).toEqual([]);
	});

	it("ranks by creation time, not id", () => {
		// The restore path resolves a prefix match to the most recently
		// CREATED entry, so the newest survives even with the highest id, and
		// the oldest goes even with the lowest.
		const d = plan([
			entry({ id: 1, key: `bun-Linux-${H("a18b")}`, createdAt: daysAgo(1) }),
			entry({ id: 5, key: `bun-Linux-${H("b29c")}`, createdAt: daysAgo(4) }),
			entry({ id: 9, key: `bun-Linux-${H("c3ad")}`, createdAt: daysAgo(8) }),
		]);
		expect(ids(d)).toEqual([9]);
	});
});

describe("planCachePrune: whole-group expiry", () => {
	it("expires a group nothing has restored for longer than the window", () => {
		const d = plan(
			[
				entry({
					id: 1,
					key: `bazel-disk-v3-linux-Linux-X64-${H("dd6b")}-${H("64a7")}`,
					createdAt: daysAgo(90),
					lastAccessedAt: daysAgo(60),
				}),
			],
			{ groupIdleDays: 30 },
		);
		expect(ids(d)).toEqual([1]);
		expect(d[0]?.reason).toBe("group-idle");
	});

	it("keeps a group that is still being restored", () => {
		const d = plan(
			[
				entry({
					id: 1,
					key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("31d4")}`,
					createdAt: daysAgo(90),
					lastAccessedAt: daysAgo(2),
				}),
			],
			{ groupIdleDays: 30 },
		);
		expect(d).toEqual([]);
	});

	it("exempts release caches: a rare cold build is worse than the space", () => {
		const d = plan(
			[
				entry({
					id: 1,
					key: `bazel-disk-v3-release-darwin-arm64-${H("e5cf")}`,
					createdAt: daysAgo(120),
					lastAccessedAt: daysAgo(90),
				}),
			],
			{ groupIdleDays: 30 },
		);
		expect(d).toEqual([]);
	});

	it("expires an unused bun group too, not just bazel ones", () => {
		// A lockfile generation nothing has restored for the whole window is
		// dead weight the same way a bazel one is.
		const d = plan(
			[entry({ id: 1, key: `bun-Linux-${H("d4be")}`, createdAt: daysAgo(90), lastAccessedAt: daysAgo(45) })],
			{ groupIdleDays: 30 },
		);
		expect(ids(d)).toEqual([1]);
		expect(d[0]?.reason).toBe("group-idle");
	});

	it("leaves PR-scoped caches to GitHub's own PR cleanup", () => {
		const d = plan(
			[
				entry({
					id: 1,
					key: `bun-Linux-${H("f6e1")}`,
					ref: "refs/pull/42/merge",
					createdAt: daysAgo(90),
					lastAccessedAt: daysAgo(90),
				}),
			],
			{ groupIdleDays: 30 },
		);
		expect(d).toEqual([]);
	});
});

describe("planCachePrune: invariants", () => {
	it("never plans the same entry twice", () => {
		const d = plan([
			entry({
				id: 1,
				key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("31d4")}`,
				ref: "refs/heads/refs/tags/v1",
				createdAt: daysAgo(99),
			}),
			entry({
				id: 2,
				key: `bazel-disk-v3-linux-Linux-X64-${H("cc5a")}-${H("42e5")}`,
				ref: "refs/heads/refs/tags/v1",
				createdAt: daysAgo(98),
			}),
		]);
		expect(ids(d)).toEqual([1, 2]);
		expect(d.every(x => x.reason === "unreachable-ref")).toBe(true);
	});

	it("an empty list is a no-op", () => {
		expect(plan([])).toEqual([]);
	});
});
