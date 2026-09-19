// Regression tests for #369: Phase 2 memory consolidation must be isolated
// per project working directory. Before the fix, a single global job key
// caused all projects' stage1 outputs to be merged into whichever project
// triggered consolidation first.
//
// Issue #41 extended the same requirement one phase earlier: Stage 1 extraction
// reads per-thread rollouts, so its candidate scan must also be workspace-scoped.

import { describe, expect, it } from "bun:test";
import {
	claimStage1Jobs,
	closeMemoryDb,
	enqueueGlobalWatermark,
	listStage1OutputsForGlobal,
	openMemoryDb,
	tryClaimGlobalPhase2Job,
	upsertThreads,
} from "@musepi/pi-coding-agent/memories/storage";

const CWD_A = "/projects/alpha";
const CWD_B = "/projects/beta";

const NOW_SEC = 1_800_000_000;

/** Claim defaults shared by the Stage-1 scope tests below. */
function claimParams(cwd?: string) {
	return {
		nowSec: NOW_SEC,
		threadScanLimit: 100,
		maxRolloutsPerStartup: 10,
		maxRolloutAgeDays: 30,
		minRolloutIdleHours: 1,
		leaseSeconds: 60,
		runningConcurrencyCap: 4,
		workerId: "test-worker",
		...(cwd === undefined ? {} : { cwd }),
	};
}

/** Two threads, one per project, both old enough and idle enough to be claimed. */
function seedTwoProjects(): ReturnType<typeof openMemoryDb> {
	const db = openMemoryDb(":memory:");
	upsertThreads(db, [
		{ id: "thread-a", updatedAt: NOW_SEC - 7200, rolloutPath: "/a.jsonl", cwd: CWD_A, sourceKind: "cli" },
		{ id: "thread-b", updatedAt: NOW_SEC - 7200, rolloutPath: "/b.jsonl", cwd: CWD_B, sourceKind: "cli" },
	]);
	return db;
}

describe("memory project isolation", () => {
	it("listStage1OutputsForGlobal filters by cwd", () => {
		const db = openMemoryDb(":memory:");
		try {
			upsertThreads(db, [
				{ id: "thread-a", updatedAt: 1000, rolloutPath: "/a.jsonl", cwd: CWD_A, sourceKind: "cli" },
				{ id: "thread-b", updatedAt: 1001, rolloutPath: "/b.jsonl", cwd: CWD_B, sourceKind: "cli" },
			]);

			// Insert stage1 outputs directly (bypassing job machinery)
			db.run("INSERT INTO stage1_outputs VALUES ('thread-a', 1000, 'alpha raw memory', 'alpha summary', null, 999)");
			db.run("INSERT INTO stage1_outputs VALUES ('thread-b', 1001, 'beta raw memory', 'beta summary', null, 999)");

			const aOutputs = listStage1OutputsForGlobal(db, 100, CWD_A);
			const bOutputs = listStage1OutputsForGlobal(db, 100, CWD_B);

			// Each project sees only its own outputs
			expect(aOutputs).toHaveLength(1);
			expect(aOutputs[0].rawMemory).toBe("alpha raw memory");
			expect(aOutputs[0].cwd).toBe(CWD_A);

			expect(bOutputs).toHaveLength(1);
			expect(bOutputs[0].rawMemory).toBe("beta raw memory");
			expect(bOutputs[0].cwd).toBe(CWD_B);
		} finally {
			closeMemoryDb(db);
		}
	});

	it("enqueueGlobalWatermark creates separate job rows per project", () => {
		const db = openMemoryDb(":memory:");
		try {
			enqueueGlobalWatermark(db, 1000, CWD_A, { forceDirtyWhenNotAdvanced: true });
			enqueueGlobalWatermark(db, 1001, CWD_B, { forceDirtyWhenNotAdvanced: true });

			const jobs = db
				.query("SELECT job_key FROM jobs WHERE kind = 'memory_consolidate_global' ORDER BY job_key")
				.all() as { job_key: string }[];

			expect(jobs).toHaveLength(2);
			expect(jobs[0].job_key).toBe(`global:${CWD_A}`);
			expect(jobs[1].job_key).toBe(`global:${CWD_B}`);
		} finally {
			closeMemoryDb(db);
		}
	});

	it("tryClaimGlobalPhase2Job claims only the requested project's job", () => {
		const db = openMemoryDb(":memory:");
		try {
			enqueueGlobalWatermark(db, 1000, CWD_A, { forceDirtyWhenNotAdvanced: true });
			enqueueGlobalWatermark(db, 1001, CWD_B, { forceDirtyWhenNotAdvanced: true });

			// Claim project A
			const resultA = tryClaimGlobalPhase2Job(db, {
				workerId: "test-worker",
				leaseSeconds: 60,
				nowSec: 2000,
				cwd: CWD_A,
			});

			expect(resultA.kind).toBe("claimed");

			// Project B's job is still claimable — not affected by A's claim
			const resultB = tryClaimGlobalPhase2Job(db, {
				workerId: "test-worker",
				leaseSeconds: 60,
				nowSec: 2000,
				cwd: CWD_B,
			});

			expect(resultB.kind).toBe("claimed");

			// Attempting to re-claim A while it's running returns skipped_running
			const resultAAgain = tryClaimGlobalPhase2Job(db, {
				workerId: "test-worker-2",
				leaseSeconds: 60,
				nowSec: 2000,
				cwd: CWD_A,
			});

			expect(resultAAgain.kind).toBe("skipped_running");
		} finally {
			closeMemoryDb(db);
		}
	});
});

describe("issue #41 — Stage 1 extraction is workspace-scoped", () => {
	it("a scoped claim returns only the requested project's threads", () => {
		const db = seedTwoProjects();
		try {
			const forA = claimStage1Jobs(db, claimParams(CWD_A));
			expect(forA).toHaveLength(1);
			expect(forA[0].threadId).toBe("thread-a");
			expect(forA[0].cwd).toBe(CWD_A);
		} finally {
			closeMemoryDb(db);
		}
	});

	it("each project claims its own thread and neither sees the other's", () => {
		const db = seedTwoProjects();
		try {
			const forA = claimStage1Jobs(db, claimParams(CWD_A));
			const forB = claimStage1Jobs(db, claimParams(CWD_B));

			expect(forA.map(c => c.threadId)).toEqual(["thread-a"]);
			expect(forB.map(c => c.threadId)).toEqual(["thread-b"]);
		} finally {
			closeMemoryDb(db);
		}
	});

	it("a project with no threads claims nothing even when others have plenty", () => {
		const db = seedTwoProjects();
		try {
			// The neighbour's threads must not be substituted for this project's.
			expect(claimStage1Jobs(db, claimParams("/projects/empty"))).toEqual([]);
		} finally {
			closeMemoryDb(db);
		}
	});

	it("an unscoped claim still scans every project (back-compat)", () => {
		const db = seedTwoProjects();
		try {
			// Omitting `cwd` preserves the previous behaviour for callers that
			// genuinely operate across workspaces.
			const all = claimStage1Jobs(db, claimParams());
			expect(all.map(c => c.threadId).sort()).toEqual(["thread-a", "thread-b"]);
		} finally {
			closeMemoryDb(db);
		}
	});

	it("a busy neighbour cannot starve this project of its own rollouts", () => {
		const db = openMemoryDb(":memory:");
		try {
			// The neighbour's threads are strictly more recent, so under the old
			// unscoped `ORDER BY updated_at DESC LIMIT` scan they filled the window
			// and this project's older thread was never reached.
			const neighbour = Array.from({ length: 5 }, (_, i) => ({
				id: `busy-${i}`,
				updatedAt: NOW_SEC - 3600 + i,
				rolloutPath: `/busy-${i}.jsonl`,
				cwd: CWD_B,
				sourceKind: "cli",
			}));
			upsertThreads(db, [
				...neighbour,
				{
					id: "mine",
					updatedAt: NOW_SEC - 7200,
					rolloutPath: "/mine.jsonl",
					cwd: CWD_A,
					sourceKind: "cli",
				},
			]);

			const scoped = claimStage1Jobs(db, { ...claimParams(CWD_A), threadScanLimit: 3 });
			expect(scoped.map(c => c.threadId)).toEqual(["mine"]);
		} finally {
			closeMemoryDb(db);
		}
	});
});
