import { afterAll, describe, expect, test } from "bun:test";
import { GuiSessionStore } from "./session-store";

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
		// prep (measured ~3.2s gap). turn_end resets it.
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
			progress: { id, status, agent: "scout", task: "do a thing", toolCount: 1, requests: 1, tokens: 1000, cost: 0.01, durationMs: 100 },
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
