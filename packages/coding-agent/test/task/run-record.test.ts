/**
 * Run-record contract.
 *
 * The load-bearing decision is that a run is keyed by the tool call rather than
 * by the agent, because that is what the payload makes groupable. These tests
 * exist to keep that honest from both ends: members sharing a call collapse into
 * one run, and two runs never merge into each other.
 */
import { describe, expect, test } from "bun:test";
import { isTerminal, RUN_HISTORY_LIMIT, RunRecorder, rollUpStatus } from "../../src/task/run-record";
import type { SubagentLifecyclePayload } from "../../src/task/types";

function event(over: Partial<SubagentLifecyclePayload> & { id: string }): SubagentLifecyclePayload {
	return {
		agent: "task",
		agentSource: "builtin" as SubagentLifecyclePayload["agentSource"],
		status: "started",
		index: 0,
		...over,
	};
}

describe("rollUpStatus", () => {
	test("is running while any member is still in flight", () => {
		// A run whose members are two-completed and one-started is not done, and
		// reporting it otherwise would let a board drop a run that is still
		// writing files.
		expect(rollUpStatus([{ status: "completed" }, { status: "completed" }, { status: "started" }])).toBe("running");
	});

	test("is completed only when every member completed", () => {
		expect(rollUpStatus([{ status: "completed" }, { status: "completed" }])).toBe("completed");
	});

	test("is failed when one member failed and the rest completed", () => {
		// The partial-apply case: two agents landed their work and one did not.
		// Calling that a success is how a board shows a green run over a tree in
		// a state nobody planned for.
		expect(rollUpStatus([{ status: "completed" }, { status: "failed" }])).toBe("failed");
	});

	test("is aborted, not failed, when a member was aborted", () => {
		// A cancelled run did not fail. Reporting it as failed sends the reader
		// looking for a bug instead of their own cancel click.
		expect(rollUpStatus([{ status: "completed" }, { status: "aborted" }])).toBe("aborted");
		// Cancellation outranks failure: the person stopped it, so reporting a
		// later failure as the outcome would describe the wrong cause.
		expect(rollUpStatus([{ status: "failed" }, { status: "aborted" }])).toBe("aborted");
	});

	test("treats a run with no members as still running", () => {
		expect(rollUpStatus([])).toBe("running");
	});

	test("terminal means not running", () => {
		expect(isTerminal("running")).toBe(false);
		expect(isTerminal("completed")).toBe(true);
		expect(isTerminal("failed")).toBe(true);
		expect(isTerminal("aborted")).toBe(true);
	});
});

describe("RunRecorder", () => {
	test("groups members that share a tool call into one run", () => {
		// This is the whole reason the record is keyed by call id: a batch is one
		// orchestration, and listing it as N runs would describe the tool rather
		// than the work.
		const recorder = new RunRecorder("s1");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", index: 0, status: "completed" }));
		recorder.apply(event({ id: "a2", parentToolCallId: "call-1", index: 1, status: "completed" }));

		const runs = recorder.list();
		expect(runs.length).toBe(1);
		expect(runs[0]?.members.map(m => m.id)).toEqual(["a1", "a2"]);
		expect(runs[0]?.status).toBe("completed");
	});

	test("keeps two tool calls apart even for the same agent name", () => {
		const recorder = new RunRecorder("s1");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", status: "completed" }));
		recorder.apply(event({ id: "a2", parentToolCallId: "call-2", status: "completed" }));

		expect(recorder.list().length).toBe(2);
		expect(recorder.get("call-1")?.members.length).toBe(1);
		expect(recorder.get("call-2")?.members.length).toBe(1);
	});

	test("ignores an event with no parent call rather than merging them all", () => {
		// Sync spawns and eval `agent()` bridges leave the field unset. Keying on
		// an absent id would collapse every unparented agent in the session into
		// one run — a run nobody started, containing work from several turns.
		const recorder = new RunRecorder("s1");
		expect(recorder.apply(event({ id: "sync-1" }))).toBeUndefined();
		expect(recorder.apply(event({ id: "sync-2", parentToolCallId: "" }))).toBeUndefined();
		expect(recorder.list().length).toBe(0);
	});

	test("replaces a member rather than appending it when its status advances", () => {
		// One agent emits started then completed. Appending would leave a
		// permanent ghost of the started event, so the run would never finish.
		const recorder = new RunRecorder("s1");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", status: "started" }));
		expect(recorder.get("call-1")?.status).toBe("running");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", status: "completed" }));
		expect(recorder.get("call-1")?.members.length).toBe(1);
		expect(recorder.get("call-1")?.status).toBe("completed");
	});

	test("records a duration only once the run is over", () => {
		const recorder = new RunRecorder("s1");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", status: "started" }));
		const running = recorder.get("call-1");
		expect(running?.durationMs).toBeUndefined();
		expect(running?.endedAtMs).toBeUndefined();

		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", status: "completed" }));
		const done = recorder.get("call-1");
		expect(done?.endedAtMs).toBeDefined();
		expect(done?.durationMs).toBeGreaterThanOrEqual(0);
		// The start belongs to the run, not to the member that finished last —
		// otherwise a fan-out reads as however long the slowest agent took to
		// start rather than how long the orchestration ran.
		expect(done?.startedAtMs).toBe(running?.startedAtMs);
	});

	test("keeps a run's own start when a later member arrives much later", () => {
		const recorder = new RunRecorder("s1");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", index: 0, status: "completed" }));
		const first = recorder.get("call-1")?.startedAtMs;
		recorder.apply(event({ id: "a2", parentToolCallId: "call-1", index: 1, status: "completed" }));
		expect(recorder.get("call-1")?.startedAtMs).toBe(first);
	});

	test("lists newest first so a board opens on the run just made", () => {
		const recorder = new RunRecorder("s1");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1" }));
		recorder.apply(event({ id: "a2", parentToolCallId: "call-2" }));
		recorder.apply(event({ id: "a3", parentToolCallId: "call-3" }));
		expect(recorder.list().map(r => r.id)).toEqual(["call-3", "call-2", "call-1"]);
	});

	test("honours a caller's limit", () => {
		const recorder = new RunRecorder("s1");
		for (let i = 0; i < 5; i++) recorder.apply(event({ id: `a${i}`, parentToolCallId: `call-${i}` }));
		expect(recorder.list(2).map(r => r.id)).toEqual(["call-4", "call-3"]);
	});

	test("caps history so an always-on process cannot grow without bound", () => {
		// The list is not a log. Nothing may depend on an evicted run existing,
		// which is why the limit drops the oldest rather than refusing new ones.
		const recorder = new RunRecorder("s1");
		for (let i = 0; i < RUN_HISTORY_LIMIT + 10; i++) {
			recorder.apply(event({ id: `a${i}`, parentToolCallId: `call-${i}` }));
		}
		const runs = recorder.list();
		expect(runs.length).toBe(RUN_HISTORY_LIMIT);
		// The survivors are the newest, and the very first is gone.
		expect(runs[0]?.id).toBe(`call-${RUN_HISTORY_LIMIT + 9}`);
		expect(recorder.get("call-0")).toBeUndefined();
	});

	test("does not evict a long run for making progress", () => {
		// Insertion order is what eviction walks, and re-setting an existing key
		// does not move it. A run that keeps reporting progress must not push
		// itself out of the list it is still appearing in.
		const recorder = new RunRecorder("s1");
		recorder.apply(event({ id: "a0", parentToolCallId: "call-0", status: "started" }));
		for (let i = 1; i < RUN_HISTORY_LIMIT + 10; i++) {
			recorder.apply(event({ id: `a${i}`, parentToolCallId: `call-${i}` }));
		}
		// Still working, still reported, still updating after all that traffic.
		recorder.apply(event({ id: "a0", parentToolCallId: "call-0", status: "started" }));
		expect(recorder.get("call-0")).toBeDefined();
		expect(recorder.get("call-0")?.status).toBe("running");
	});

	test("notifies subscribers on each change and stops after they leave", () => {
		const recorder = new RunRecorder("s1");
		const seen: string[] = [];
		const off = recorder.subscribe(run => seen.push(`${run.id}:${run.status}`));

		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", status: "started" }));
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", status: "completed" }));
		expect(seen).toEqual(["call-1:running", "call-1:completed"]);

		off();
		recorder.apply(event({ id: "a2", parentToolCallId: "call-2", status: "completed" }));
		expect(seen.length).toBe(2);
	});

	test("carries the session the run belongs to", () => {
		// A board fed several sessions needs to tell them apart, and the recorder
		// is the only place that knows which one it belongs to.
		const recorder = new RunRecorder("sess-42");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1" }));
		expect(recorder.get("call-1")?.sessionId).toBe("sess-42");
	});

	test("keeps a member's session file so its transcript can be opened", () => {
		const recorder = new RunRecorder("s1");
		recorder.apply(event({ id: "a1", parentToolCallId: "call-1", status: "completed", sessionFile: "/s/a1.jsonl" }));
		expect(recorder.get("call-1")?.members[0]?.sessionFile).toBe("/s/a1.jsonl");
	});
});
