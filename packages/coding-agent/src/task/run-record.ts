/**
 * Run records: one row per orchestration, its members being the agents that ran
 * under it.
 *
 * `workflowz` already makes the agent orchestrate a fan-out — the keyword
 * appends a hidden notice telling it to decompose work and spawn subagents. What
 * was missing was any trace afterwards. A run left no record, so there was
 * nothing to look back at, nothing for a board to render, and nothing a side
 * conversation could hang off.
 *
 * The unit of record is the tool call, not the agent. That choice is not a
 * preference — the payload settles it. Every subagent spawned by one `task`
 * invocation carries the same `parentToolCallId` (`task/index.ts` passes the
 * call's `toolCallId` to each spawn in the loop, while `agentId` and `index`
 * vary per member), so the call id is already the only key that groups a
 * fan-out. Recording per agent would reproduce the subagent HUD that already
 * exists and add nothing.
 *
 * Runs are ephemeral by design. They are not session state and not a log: this
 * keeps at most {@link RUN_HISTORY_LIMIT} and drops the oldest, so an
 * always-on process cannot grow a store just because somebody left it open. A
 * run that fell off the end was never durable, and nothing may depend on one
 * being there.
 *
 * @module task/run-record
 */

import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "./types";

/** How many runs are kept. Oldest are dropped first. */
export const RUN_HISTORY_LIMIT = 200;

/** Where a run is in its life. Derived from the members, never set directly. */
export type RunStatus = "running" | "completed" | "failed" | "aborted";

/** One agent within a run. */
export interface RunMember {
	readonly id: string;
	readonly agent: string;
	readonly description?: string;
	readonly status: SubagentLifecyclePayload["status"];
	readonly index: number;
	/** The subagent's own session file, when it wrote one. */
	readonly sessionFile?: string;
	/** Whether the parent turn kept working while this ran. */
	readonly detached?: boolean;
}

/** One orchestration and the agents that ran under it. */
export interface RunRecord {
	readonly id: string;
	readonly sessionId: string;
	readonly members: readonly RunMember[];
	readonly status: RunStatus;
	readonly startedAtMs: number;
	/** Absent while the run is still going. */
	readonly endedAtMs?: number;
	/** Wall time from the first member to the last. Meaningless while running. */
	readonly durationMs?: number;
}

/**
 * Roll member statuses up into the run's status.
 *
 * The precedence is deliberate and is the one a person reading a board needs:
 * a single failure makes the run failed even if the others completed, because a
 * partially-applied plan is not a success. `aborted` outranks both — a run the
 * person cancelled did not "fail", it was stopped, and reporting that as a
 * failure sends them looking for a bug that is not there. A run still has
 * members in flight, which is the only case where `running` is correct.
 */
export function rollUpStatus(members: readonly { status: SubagentLifecyclePayload["status"] }[]): RunStatus {
	if (members.length === 0) return "running";
	if (members.some(m => m.status === "aborted")) return "aborted";
	if (members.some(m => m.status === "failed")) return "failed";
	if (members.every(m => m.status === "completed")) return "completed";
	return "running";
}

/** True once no member can still change. */
export function isTerminal(status: RunStatus): boolean {
	return status !== "running";
}

/**
 * An in-memory ring of run records for one session.
 *
 * Observers subscribe rather than poll: the daemon forwards every lifecycle
 * event, so a run advances without the record layer having to know anything
 * about the executor.
 */
export class RunRecorder {
	readonly #sessionId: string;
	readonly #runs = new Map<string, RunRecord>();
	readonly #listeners = new Set<(run: RunRecord) => void>();

	constructor(sessionId: string) {
		this.#sessionId = sessionId;
	}

	/** The runs, newest first. */
	list(limit = RUN_HISTORY_LIMIT): readonly RunRecord[] {
		return [...this.#runs.values()].reverse().slice(0, limit);
	}

	get(id: string): RunRecord | undefined {
		return this.#runs.get(id);
	}

	/** Called after every record change, with the run that changed. */
	subscribe(listener: (run: RunRecord) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Fold one lifecycle event into the run it belongs to. */
	apply(payload: SubagentLifecyclePayload): RunRecord | undefined {
		// Sync spawns and eval `agent()` bridges leave the field unset; grouping by
		// an absent id would merge every unparented agent in the session into one
		// run, which is worse than not recording it.
		const runId = payload.parentToolCallId;
		if (runId === undefined || runId === "") return undefined;

		const existing = this.#runs.get(runId);
		const members = existing === undefined ? [] : [...existing.members];
		const at = members.findIndex(m => m.id === payload.id);
		const member: RunMember = {
			id: payload.id,
			agent: payload.agent,
			...(payload.description === undefined ? {} : { description: payload.description }),
			status: payload.status,
			index: payload.index,
			...(payload.sessionFile === undefined ? {} : { sessionFile: payload.sessionFile }),
			...(payload.detached === undefined ? {} : { detached: payload.detached }),
		};
		if (at === -1) members.push(member);
		else members[at] = member;

		const status = rollUpStatus(members);
		// The first member to arrive starts the run. Using the recorder's own
		// construction time instead would give every run in the session the same
		// start, and a list of runs would show them all as one long span.
		const startedAtMs = existing?.startedAtMs ?? Date.now();
		const endedAtMs = Date.now();
		const record: RunRecord = {
			id: runId,
			sessionId: this.#sessionId,
			members,
			status,
			startedAtMs,
			...(status === "running" ? {} : { endedAtMs, durationMs: endedAtMs - startedAtMs }),
		};
		this.#runs.set(runId, record);
		this.#evict();
		for (const listener of this.#listeners) listener(record);
		return record;
	}

	/**
	 * Drop the oldest runs past the limit.
	 *
	 * Map preserves insertion order, so the first key is the oldest run that has
	 * not been superseded — which is what "oldest" means here. A run that keeps
	 * receiving updates stays put: re-setting an existing key does not move it,
	 * so a long run is not evicted by its own progress.
	 */
	#evict(): void {
		while (this.#runs.size > RUN_HISTORY_LIMIT) {
			const oldest = this.#runs.keys().next();
			if (oldest.done === true) return;
			this.#runs.delete(oldest.value);
		}
	}
}

/**
 * Feed a session's event bus into a recorder.
 *
 * @returns a disposer that stops recording. The recorder keeps whatever it had,
 * which is what a UI showing runs already in flight wants.
 */
export function recordRunsFrom(
	bus: { on: (channel: string, fn: (data: unknown) => void) => () => void },
	recorder: RunRecorder,
): () => void {
	return bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		recorder.apply(data as SubagentLifecyclePayload);
	});
}
