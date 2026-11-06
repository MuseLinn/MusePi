import { describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../async";
import { requestAgentDetach, setAgentDetachHandle } from "./detach-registry";
import { adoptRunningSpawn, createAdoptedResult, isAdoptedResult } from "./detach-spawn";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	return { promise, resolve, reject };
}

describe("adoptRunningSpawn", () => {
	it("registers one task job that waits on the already-running promise", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const run = deferred<{ text: string }>();
		let settled = 0;
		const jobId = adoptRunningSpawn({
			manager,
			agentId: "AdoptOne",
			runPromise: run.promise,
			format: execution => `final: ${execution.text}`,
			ownerId: "session-1",
			toolCallId: "call-1",
			onSettled: () => {
				settled += 1;
			},
		});
		const job = manager.getJob(jobId);
		expect(job?.type).toBe("task");
		expect(job?.label).toBe("AdoptOne");
		expect(job?.agentId).toBe("AdoptOne");
		expect(job?.ownerId).toBe("session-1");
		expect(job?.toolCallId).toBe("call-1");
		expect(job?.status).toBe("running");
		expect(settled).toBe(0);

		run.resolve({ text: "ok" });
		await job!.promise;
		expect(job?.status).toBe("completed");
		expect(job?.resultText).toBe("final: ok");
		expect(settled).toBe(1);
	});

	it("reports a rejected run as failed text instead of dropping it", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const run = deferred<{ text: string }>();
		const jobId = adoptRunningSpawn({
			manager,
			agentId: "AdoptFail",
			runPromise: run.promise,
			format: execution => execution.text,
		});
		run.reject(new Error("subagent crashed"));
		const job = manager.getJob(jobId)!;
		await job.promise;
		expect(job.resultText).toBe("Task execution failed: subagent crashed");
	});

	it("cancelling the job cancels the adopted run instead of only its delivery", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const run = deferred<string>();
		const cancels: unknown[] = [];
		const jobId = adoptRunningSpawn({
			manager,
			agentId: "AdoptCancel",
			runPromise: run.promise,
			format: execution => execution,
			onCancel: reason => cancels.push(reason),
		});
		await Promise.resolve(); // let the body attach its abort listener
		expect(manager.cancel(jobId)).toBe(true);
		expect(cancels).toHaveLength(1);
		run.resolve("stopped");
		const job = manager.getJob(jobId)!;
		await job.promise;
		expect(job.status).toBe("cancelled");
	});

	it("releases the transferred permit in the job body", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const run = deferred<string>();
		const releases: string[] = [];
		const jobId = adoptRunningSpawn({
			manager,
			agentId: "AdoptPermit",
			runPromise: run.promise,
			format: execution => execution,
			onSettled: () => releases.push("released"),
		});
		await Promise.resolve(); // let the job body attach to the pending run
		run.resolve("done");
		await manager.getJob(jobId)!.promise;
		expect(releases).toEqual(["released"]);
	});
});

describe("adopted result payload", () => {
	it("carries the job id and empty details so this turn returns immediately", () => {
		const result = createAdoptedResult("AdoptedCard", "job-42", 1200);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("`AdoptedCard`");
		expect(text).toContain("job `job-42`");
		expect(result.details).toEqual({ projectAgentsDir: null, results: [], totalDurationMs: 1200 });
		expect(isAdoptedResult(result)).toBe(true);
	});

	it("does not mark ordinary payloads as adopted", () => {
		expect(isAdoptedResult({ content: [], details: { results: [] } })).toBe(false);
	});
});

describe("detach request → adoption chain", () => {
	it("registers exactly one job and returns the placeholder to the caller", async () => {
		const registered: string[] = [];
		const manager = {
			register: ((type: string, label: string) => {
				registered.push(`${type}:${label}`);
				return `job-${registered.length}`;
			}) as AsyncJobManager["register"],
		};
		const run = deferred<string>();
		run.resolve("finished");
		let placeholder: ReturnType<typeof createAdoptedResult> | undefined;
		const unregister = setAgentDetachHandle("DetachChain", async () => {
			const jobId = adoptRunningSpawn({
				manager,
				agentId: "DetachChain",
				runPromise: run.promise,
				format: execution => execution,
			});
			placeholder = createAdoptedResult("DetachChain", jobId, 5);
			return { ok: true, jobId };
		});
		try {
			expect(await requestAgentDetach("DetachChain")).toEqual({ ok: true, jobId: "job-1" });
			expect(await requestAgentDetach("DetachChain")).toEqual({
				ok: false,
				error: "agent is not running in the foreground",
			});
		} finally {
			unregister();
		}
		expect(registered).toEqual(["task:DetachChain"]);
		expect(placeholder && isAdoptedResult(placeholder)).toBe(true);
	});
});
