/**
 * Async job live-output contract: bounded ring per job, tail reads that mark
 * truncation, snapshot metadata (kind/questionCount/toolCallId/outputBytes),
 * and owner scoping so a subagent's teardown never cancels another agent's
 * pending question job.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@musepi/pi-coding-agent/async";

const managers: AsyncJobManager[] = [];

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({});
	managers.push(manager);
	return manager;
}

function registerImmediate(
	manager: AsyncJobManager,
	text: string,
	options?: Parameters<AsyncJobManager["register"]>[3],
): string {
	return manager.register("task", "job", async () => text, options);
}

/** A job body that only settles when its abort signal fires, like a real one. */
function waitForAbort(signal: AbortSignal): Promise<string> {
	return new Promise<string>((_resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	});
}

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		await manager.dispose({ timeoutMs: 50 });
	}
	AsyncJobManager.resetForTests();
});

describe("AsyncJobManager live output", () => {
	it("returns undefined for an unknown job", () => {
		const manager = createManager();
		expect(manager.getJobOutput("missing")).toBeUndefined();
	});

	it("keeps only the newest bytes of a job over its ring budget and reports truncation", async () => {
		const manager = createManager();
		const jobId = manager.register(
			"bash",
			"chatty",
			async ({ appendOutput }) => {
				appendOutput("first-");
				appendOutput("second-");
				appendOutput("third");
				return "";
			},
			{ maxOutputBytes: 12 },
		);
		await manager.getJob(jobId)!.promise;

		const all = manager.getJobOutput(jobId);
		expect(all?.output).toBe("second-third");
		expect(all?.truncated).toBe(true);
		expect(manager.snapshotJob(manager.getJob(jobId)!).outputBytes).toBe(12);
	});

	it("returns the requested tail and marks it truncated, and the full ring untruncated", async () => {
		const manager = createManager();
		const jobId = registerImmediate(manager, "0123456789");
		await manager.getJob(jobId)!.promise;

		expect(manager.getJobOutput(jobId, { tail: 4 })).toEqual({ output: "6789", truncated: true });
		expect(manager.getJobOutput(jobId, { tail: 100 })).toEqual({ output: "0123456789", truncated: false });
		expect(manager.getJobOutput(jobId, { tail: Number.NaN })).toEqual({ output: "0123456789", truncated: false });
		expect(manager.getJobOutput(jobId)).toEqual({ output: "0123456789", truncated: false });
	});

	it("never splits a multi-byte character when trimming by bytes", async () => {
		const manager = createManager();
		const jobId = manager.register(
			"bash",
			"unicode",
			async ({ appendOutput }) => {
				appendOutput("汉汉汉");
				return "";
			},
			{ maxOutputBytes: 4 },
		);
		await manager.getJob(jobId)!.promise;

		const output = manager.getJobOutput(jobId);
		expect(output?.output).toBe("汉");
		expect(output?.output).not.toContain("\uFFFD");
	});

	it("appends the job result so a settled job keeps readable output", async () => {
		const manager = createManager();
		const jobId = registerImmediate(manager, "done ✅");
		await manager.getJob(jobId)!.promise;

		expect(manager.getJobOutput(jobId)?.output).toBe("done ✅");
	});

	it("exposes question metadata on the job snapshot", async () => {
		const manager = createManager();
		const gate = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"Ask: Which auth?",
			async () => {
				await gate.promise;
				return "answered";
			},
			{ kind: "question", questionCount: 2, toolCallId: "call-9", ownerId: "Main" },
		);

		const summary = manager.snapshotJob(manager.getJob(jobId)!);
		expect(summary).toMatchObject({
			id: jobId,
			type: "task",
			status: "running",
			kind: "question",
			questionCount: 2,
			toolCallId: "call-9",
			outputBytes: 0,
		});

		gate.resolve();
		await manager.getJob(jobId)!.promise;
	});

	it("keeps a parent's pending question alive through a subagent teardown", async () => {
		const manager = createManager();
		const pendingQuestion = manager.register("task", "Ask: which auth?", async ({ signal }) => waitForAbort(signal), {
			kind: "question",
			questionCount: 1,
			toolCallId: "call-1",
			ownerId: "Main",
		});
		const subagentJob = manager.register("bash", "sub work", async ({ signal }) => waitForAbort(signal), {
			ownerId: "Sub",
		});

		const reap = await manager.cancelAndReapOwnerJobs("Sub", Date.now() + 1_000);
		expect(reap.settled).toBe(true);

		expect(manager.getJob(subagentJob)?.status).toBe("cancelled");
		expect(manager.getJob(pendingQuestion)?.status).toBe("running");
		expect(manager.getRunningJobs({ ownerId: "Main" }).map(job => job.id)).toEqual([pendingQuestion]);

		manager.cancel(pendingQuestion);
		await manager.getJob(pendingQuestion)?.promise;
	});
});
