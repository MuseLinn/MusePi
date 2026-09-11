import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { documentUnfocused, GuiSessionStore } from "./session-store";

// Minimal snapshot shape the store needs to construct a MaterializedView.
function emptySnapshot() {
	return { entries: [], state: {} as never, cursor: 0 };
}

function updateEvent(timestamp: number, text: string) {
	return {
		kind: "message_update",
		payload: {
			type: "message_update",
			message: { role: "assistant", timestamp, content: [{ type: "text", text }] },
		},
	} as never;
}

describe("GuiSessionStore frame coalescing", () => {
	const raf = globalThis.requestAnimationFrame;
	const mq = globalThis.queueMicrotask;
	afterAll(() => {
		// restore globals if the store's fallback captured them
		if (raf) (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
	});

	test("burst of same-message updates emits once", async () => {
		// Force the microtask fallback path (no RAF in test env by default).
		const store = new GuiSessionStore("s1", emptySnapshot(), "/work");
		let emits = 0;
		store.subscribe(() => emits++);

		for (let i = 0; i < 100; i++) {
			store.apply(updateEvent(1000, `chunk ${i}`));
		}
		// Nothing emitted synchronously — the burst is pending.
		expect(emits).toBe(0);
		await new Promise(r => setTimeout(r, 0));
		// The whole burst collapsed to a single flush.
		expect(emits).toBe(1);
		const snap = store.getSnapshot();
		expect(snap.entries.length).toBe(1);
		const msg = (snap.entries[0] as { message?: { content?: Array<{ text?: string }> } }).message;
		// Only the final cumulative payload survived the coalescing.
		expect(msg?.content?.[0]?.text).toBe("chunk 99");
	});

	test("two distinct messages still both land", async () => {
		const store = new GuiSessionStore("s2", emptySnapshot(), "/work");
		let emits = 0;
		store.subscribe(() => emits++);

		store.apply(updateEvent(1000, "a1"));
		store.apply(updateEvent(1000, "a2"));
		store.apply(updateEvent(2000, "b1"));
		await new Promise(r => setTimeout(r, 0));

		expect(emits).toBe(1);
		const snap = store.getSnapshot();
		expect(snap.entries.length).toBe(2);
	});

	test("approval-request applies synchronously", () => {
		const store = new GuiSessionStore("s3", emptySnapshot(), "/work");
		let emits = 0;
		store.subscribe(() => emits++);
		store.apply({
			kind: "approval-request",
			payload: { requestId: "r1", tool: "bash" },
		} as never);
		expect(emits).toBeGreaterThanOrEqual(1);
		expect(store.getSnapshot().approvals.length).toBe(1);
	});

	test("user message_start flips working on immediately (bubble == indicator frame)", async () => {
		// DSH/craft/proma parity: the working indicator must start the moment
		// the user's own message is visible (optimistic emit), not when
		// agent_start / turn_start finally lands after auto-thinking + provider
		// prep (measured ~3.2s gap).
		const store = new GuiSessionStore("s4", emptySnapshot(), "/work");
		store.apply({
			kind: "event",
			payload: {
				type: "message_start",
				message: { role: "user", timestamp: 1000, content: [{ type: "text", text: "hi" }] },
			},
		} as never);
		await new Promise(r => setTimeout(r, 0));
		expect(store.getSnapshot().working).toBe(true);

		// Run-level contract (user direction): turn_end fires per tool batch
		// INSIDE one run — only agent_end retires the stop capsule. A mid-run
		// boundary must NOT flip the button back to send during provider
		// prep between rounds.
		store.apply({ kind: "event", payload: { type: "turn_end", message: {}, toolResults: [] } } as never);
		await new Promise(r => setTimeout(r, 0));
		expect(store.getSnapshot().working).toBe(true);

		store.apply({ kind: "event", payload: { type: "agent_end", messages: [] } } as never);
		await new Promise(r => setTimeout(r, 0));
		expect(store.getSnapshot().working).toBe(false);
	});
});

describe("GuiSessionStore subagent hydration + ownership", () => {
	function progressWrapper(id: string, status: string, sessionId: string) {
		return {
			index: 0,
			agent: "scout",
			task: "do a thing",
			progress: {
				id,
				status,
				agent: "scout",
				task: "do a thing",
				toolCount: 1,
				requests: 1,
				tokens: 1000,
				cost: 0.01,
				durationMs: 100,
			},
			sessionId,
		} as never;
	}

	test("constructor seeds running tool calls + subagent progress from the subscribe snapshot", () => {
		const store = new GuiSessionStore(
			"s1",
			{
				...emptySnapshot(),
				activeTools: [{ toolCallId: "t1", toolName: "task", args: {}, startedAt: 100 }],
				agentsProgress: [progressWrapper("a1", "running", "s1")],
			},
			"/work",
		);
		const snap = store.getSnapshot();
		expect(snap.activeTools.get("t1")?.toolName).toBe("task");
		expect(snap.agents.some(a => a.id === "a1" && a.status === "running")).toBe(true);
		expect(snap.progress.get("a1")?.progress.id).toBe("a1");
	});

	test("agent-progress tagged for another session is dropped; own session lands", async () => {
		const store = new GuiSessionStore("s2", emptySnapshot(), "/work");
		// Cross-session frame must never paint this session's swarm visuals.
		store.apply({ kind: "agent-progress", payload: progressWrapper("a1", "running", "other-session") } as never);
		await new Promise(r => setTimeout(r, 0));
		expect(store.getSnapshot().agents).toHaveLength(0);

		store.apply({ kind: "agent-progress", payload: progressWrapper("a1", "running", "s2") } as never);
		await new Promise(r => setTimeout(r, 0));
		expect(store.getSnapshot().agents.some(a => a.id === "a1")).toBe(true);
	});
});

/**
 * The focus predicate in full — every branch, no DOM. The store reads the
 * ambient document, so exercising these through it would mean installing a
 * global stub, which changes what libraries loaded later in the same process
 * infer about the environment (emotion captures `isBrowser` at import and then
 * requires a real `querySelectorAll`). The predicate is exported precisely so
 * its branches can be proven without that.
 */
describe("documentUnfocused", () => {
	test("no document at all counts as unfocused", () => {
		expect(documentUnfocused(undefined)).toBe(true);
	});

	test("a hidden document counts as unfocused even while focused", () => {
		expect(documentUnfocused({ hidden: true, hasFocus: () => true })).toBe(true);
	});

	test("a focused, visible document counts as focused", () => {
		expect(documentUnfocused({ hidden: false, hasFocus: () => true })).toBe(false);
	});

	test("a visible but unfocused document counts as unfocused", () => {
		expect(documentUnfocused({ hidden: false, hasFocus: () => false })).toBe(true);
	});

	// A document that cannot answer the question must not throw: this runs
	// while handling a completion, and a throw also skipped the subagent's
	// hasSessionFile upgrade plus its notification.
	test("a document without hasFocus is unfocused rather than a crash", () => {
		expect(documentUnfocused({ hidden: false })).toBe(true);
	});
});

describe("GuiSessionStore unviewed subagent completions", () => {
	// This suite's contract is "the user wasn't looking", so state that premise
	// explicitly instead of inheriting it from the ambient environment: a
	// sibling file's DOM shim (test/dom-shim.ts) runs in the same process, and
	// the assertions used to depend on whether it had run yet — green alone,
	// red in the full suite. Removing the document (restored after) is the
	// unfocused state, and unlike installing a stub it cannot mislead a library
	// that is still loading.
	//
	// agent-lifecycle envelopes are frame-coalesced: apply() pushes to
	// #pending and the flush runs on a queueMicrotask. Await one microtask
	// (registered after the flush's) to observe the settled snapshot —
	// deterministic, no wall-clock timers.
	let savedDocument: unknown;
	beforeEach(() => {
		savedDocument = (globalThis as { document?: unknown }).document;
		delete (globalThis as { document?: unknown }).document;
	});
	afterEach(() => {
		(globalThis as { document?: unknown }).document = savedDocument;
	});

	// agent-lifecycle envelopes are frame-coalesced: apply() pushes to
	// #pending and the flush runs on a queueMicrotask. Await one microtask
	// (registered after the flush's) to observe the settled snapshot —
	// deterministic, no wall-clock timers.

	function flush(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		queueMicrotask(resolve);
		return promise;
	}

	function lifecycleEvent(id: string, status: string, sessionId: string) {
		return {
			kind: "agent-lifecycle",
			payload: { id, agent: "scout", status, index: 0, sessionId },
		} as never;
	}

	test("completed while window unfocused marks the agent unviewed", async () => {
		const store = new GuiSessionStore("s-u1", emptySnapshot(), "/work");
		store.apply(lifecycleEvent("a1", "completed", "s-u1"));
		await flush();
		expect(store.getSnapshot().unviewedCompleted).toContain("a1");
	});

	test("markAgentViewed clears the marker for the current session only", async () => {
		const store = new GuiSessionStore("s-u2", emptySnapshot(), "/work");
		store.apply(lifecycleEvent("a1", "completed", "s-u2"));
		await flush();
		expect(store.getSnapshot().unviewedCompleted).toContain("a1");

		store.markAgentViewed("a1");
		expect(store.getSnapshot().unviewedCompleted).not.toContain("a1");
	});

	test("non-completed lifecycle statuses never mark unviewed", async () => {
		const store = new GuiSessionStore("s-u3", emptySnapshot(), "/work");
		store.apply(lifecycleEvent("a1", "started", "s-u3"));
		store.apply(lifecycleEvent("a2", "failed", "s-u3"));
		store.apply(lifecycleEvent("a3", "aborted", "s-u3"));
		await flush();
		expect(store.getSnapshot().unviewedCompleted).toHaveLength(0);
	});

	test("completion tagged for another session never marks this one", async () => {
		const store = new GuiSessionStore("s-u4", emptySnapshot(), "/work");
		store.apply(lifecycleEvent("a1", "completed", "other-session"));
		await flush();
		expect(store.getSnapshot().unviewedCompleted).toHaveLength(0);
	});

	test("markAgentViewed on an unmarked id is a no-op and does not emit", async () => {
		const store = new GuiSessionStore("s-u5", emptySnapshot(), "/work");
		let emits = 0;
		store.subscribe(() => emits++);

		store.markAgentViewed("never-marked");
		expect(store.getSnapshot().unviewedCompleted).toHaveLength(0);
		// No registry hit → no snapshot rebuild → no listener notification.
		expect(emits).toBe(0);
	});

	test("marks survive a session switch away and back (registry keyed by sessionId)", async () => {
		// The store is disposed and recreated per session switch; the marker
		// must live in the module-level registry to survive the round trip —
		// the exact case this feature exists for.
		const first = new GuiSessionStore("s-u6", emptySnapshot(), "/work");
		first.apply(lifecycleEvent("a1", "completed", "s-u6"));
		await flush();
		first.dispose();

		const second = new GuiSessionStore("s-u6", emptySnapshot(), "/work");
		expect(second.getSnapshot().unviewedCompleted).toContain("a1");

		second.markAgentViewed("a1");
		expect(second.getSnapshot().unviewedCompleted).not.toContain("a1");
	});

	test("a revived subagent (lifecycle started) clears its stale unviewed mark", async () => {
		const store = new GuiSessionStore("s-u7", emptySnapshot(), "/work");
		store.apply(lifecycleEvent("a1", "completed", "s-u7"));
		await flush();
		expect(store.getSnapshot().unviewedCompleted).toContain("a1");

		// Same id comes back as "started" (revival / keep-alive re-run): the
		// completed-unviewed fact no longer holds while it runs again.
		store.apply(lifecycleEvent("a1", "started", "s-u7"));
		await flush();
		expect(store.getSnapshot().unviewedCompleted).not.toContain("a1");
	});
});
