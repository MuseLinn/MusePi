/**
 * Store batching contract: one render per coalesced batch.
 *
 * The daemon pushes an envelope per streamed frame — a subagent progress frame
 * per step, a `message_update` per token. Every emit rebuilds the snapshot and
 * re-renders each subscriber, so an emit per envelope is what made a live turn
 * expensive. These tests pin the observable consequence: N envelopes in one
 * batch produce ONE emit.
 */
import { describe, expect, test } from "bun:test";
import { GuiSessionStore, hasPendingSessionFlush } from "../src/lib/session-store";

function emptySnapshot() {
	return { entries: [], state: {} as never, cursor: 0 };
}

/** Await the coalescing window (microtask flush + 100 ms batch). */
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	for (let i = 0; i < 12 && hasPendingSessionFlush(); i++) {
		await new Promise(r => setTimeout(r, 25));
	}
}

function progressEvent(id: string, sessionId: string) {
	return {
		kind: "agent-progress",
		payload: {
			progress: { id, agent: "scout", status: "running", index: 0 },
			sessionId,
		},
	} as never;
}

describe("GuiSessionStore flush batching", () => {
	test("a burst of subagent progress frames emits once, not once per frame", async () => {
		// The pre-batching behavior was an emit (and a full snapshot rebuild)
		// per frame — a swarm of subagents multiplied the shell's render cost.
		const store = new GuiSessionStore("batch-1", emptySnapshot(), "/work");
		let emits = 0;
		store.subscribe(() => emits++);
		for (let i = 0; i < 20; i++) {
			store.apply(progressEvent(`agent-${i}`, "batch-1"));
		}
		await flush();
		expect(emits).toBe(1);
		expect(store.getSnapshot().agents).toHaveLength(20);
	});

	test("frames for another session never emit at all", async () => {
		// Ownership routing: a foreign frame changes nothing here, so it must
		// not cost a snapshot rebuild + render of every subscriber.
		const store = new GuiSessionStore("batch-2", emptySnapshot(), "/work");
		let emits = 0;
		store.subscribe(() => emits++);
		for (let i = 0; i < 10; i++) {
			store.apply(progressEvent(`agent-${i}`, "someone-else"));
		}
		await flush();
		expect(emits).toBe(0);
		expect(store.getSnapshot().agents).toHaveLength(0);
	});

	test("a mixed batch still emits once and lands every event", async () => {
		const store = new GuiSessionStore("batch-3", emptySnapshot(), "/work");
		let emits = 0;
		store.subscribe(() => emits++);
		store.apply(progressEvent("a1", "batch-3"));
		store.apply(progressEvent("a2", "batch-3"));
		store.apply({ kind: "state", payload: { isStreaming: true } } as never);
		store.apply(progressEvent("a3", "batch-3"));
		await flush();
		expect(emits).toBe(1);
		const snap = store.getSnapshot();
		expect(snap.agents).toHaveLength(3);
		expect(snap.working).toBe(true);
	});

	test("an approval still applies synchronously — latency is UI-critical", async () => {
		// The batch window must not delay the dialog: the user is blocked on it.
		const store = new GuiSessionStore("batch-4", emptySnapshot(), "/work");
		let emits = 0;
		store.subscribe(() => emits++);
		store.apply({ kind: "approval-request", payload: { requestId: "r1", tool: "bash" } } as never);
		expect(emits).toBe(1);
		expect(store.getSnapshot().approvals).toHaveLength(1);
	});
});
