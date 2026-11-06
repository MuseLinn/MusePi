/**
 * Adoption of an already-running inline spawn as a background job.
 *
 * The foreground run keeps a single `runPromise`; detaching must not restart
 * the subagent, so the job body simply waits on that same promise and returns
 * the text it would have handed back to the current turn. Everything here is
 * pure wiring so it can be unit-tested without an executor.
 */
import type { AgentToolResult } from "@musepi/pi-agent-core";
import type { AsyncJobManager } from "../async";
import type { TaskToolDetails } from "./types";

/** Results produced by a detach adoption, so callers can keep their row "running". */
const adoptedResults = new WeakSet<object>();

export function isAdoptedResult(result: object): boolean {
	return adoptedResults.has(result);
}

/**
 * Tool result returned in place of the real one once a foreground spawn has
 * moved to the background: the current turn stops waiting, and the job manager
 * delivers the spawn's own text when it settles.
 */
export function createAdoptedResult(
	agentId: string,
	jobId: string,
	totalDurationMs: number,
): AgentToolResult<TaskToolDetails> {
	const result: AgentToolResult<TaskToolDetails> = {
		content: [
			{
				type: "text",
				text: `Agent \`${agentId}\` is now running in the background (job \`${jobId}\`). Its result will be delivered as a background task.`,
			},
		],
		details: { projectAgentsDir: null, results: [], totalDurationMs },
	};
	adoptedResults.add(result);
	return result;
}

export interface AdoptRunningSpawnOptions<T> {
	manager: Pick<AsyncJobManager, "register">;
	agentId: string;
	/** Job label; defaults to the agent id, matching `task` job registration. */
	label?: string;
	toolCallId?: string;
	ownerId?: string;
	/** The inline run this job adopts. Never started by the job itself. */
	runPromise: Promise<T>;
	/** Final delivery text for one settled run. */
	format(execution: T): string;
	/** Runs in the job body's `finally` — the hook that returns a spawn permit. */
	onSettled?(): void;
	/** Cancel propagation: the adopted job owns the run now, so cancelling the
	 *  job must stop the agent instead of only suppressing its delivery. */
	onCancel?(reason: unknown): void;
}

/**
 * Register a `task` job whose body waits on `runPromise`. A rejected run is
 * reported as `Task execution failed: …` rather than being dropped, so the
 * conversation still learns why the agent stopped.
 *
 * Throws when the manager refuses the registration (running-job cap, disposed
 * manager); callers surface that as a failed detach request.
 */
export function adoptRunningSpawn<T>(options: AdoptRunningSpawnOptions<T>): string {
	return options.manager.register(
		"task",
		options.label ?? options.agentId,
		async ctx => {
			const onAbort = (): void => options.onCancel?.(ctx.signal.reason);
			ctx.signal.addEventListener("abort", onAbort, { once: true });
			try {
				return options.format(await options.runPromise);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Task execution failed: ${message}`;
			} finally {
				ctx.signal.removeEventListener("abort", onAbort);
				options.onSettled?.();
			}
		},
		{
			id: options.agentId,
			agentId: options.agentId,
			...(options.ownerId ? { ownerId: options.ownerId } : {}),
			...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
		},
	);
}
