import { describe, expect, it } from "bun:test";
import { GuiSessionStore } from "../src/lib/session-store";

// Subagent transcript availability (SubagentPanel): the daemon attaches the
// subagent's session file to the progress/lifecycle envelopes
// (task/executor → TASK_SUBAGENT_*_CHANNEL → GUI stream); the store must
// land it on the AgentSnapshot.hasSessionFile flag, which gates the drawer's
// agents.transcript polling. Regression: the synthesized row previously
// hardcoded hasSessionFile:false, so the drawer always showed
// "no transcript available" even for subagents with real transcripts.

function progressFrame(id: string, agent: string, sessionFile?: string) {
	return {
		kind: "agent-progress",
		seq: 0,
		payload: {
			index: 0,
			agent,
			task: "t",
			sessionFile,
			progress: {
				index: 0,
				id,
				agent,
				status: "running",
				task: "t",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
		},
	};
}

function lifecycleFrame(id: string, agent: string, status: "started" | "completed", sessionFile?: string) {
	return { kind: "agent-lifecycle", seq: 0, payload: { id, agent, status, index: 0, sessionFile } };
}

/** apply() frame-coalesces via a microtask flush — yield twice before reading. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("GuiSessionStore subagent transcript availability", () => {
	it("synthesizes the agent row with hasSessionFile from the progress envelope", async () => {
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");
		store.apply(progressFrame("A", "worker-a", "/tmp/a.jsonl"));
		store.apply(progressFrame("B", "worker-b"));
		await settle();

		const snap = store.getSnapshot();
		expect(snap.agents.find(a => a.id === "A")?.hasSessionFile).toBe(true);
		expect(snap.agents.find(a => a.id === "B")?.hasSessionFile).toBe(false);
	});

	it("upgrades an existing row when the lifecycle envelope carries the session file", async () => {
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");
		store.apply(progressFrame("A", "worker-a"));
		await settle();
		expect(store.getSnapshot().agents.find(a => a.id === "A")?.hasSessionFile).toBe(false);

		store.apply(lifecycleFrame("A", "worker-a", "started", "/tmp/a.jsonl"));
		await settle();
		expect(store.getSnapshot().agents.find(a => a.id === "A")?.hasSessionFile).toBe(true);
	});

	it("keeps hasSessionFile on the row after a terminal lifecycle (drawer still readable)", async () => {
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");
		store.apply(progressFrame("A", "worker-a", "/tmp/a.jsonl"));
		await settle();

		store.apply(lifecycleFrame("A", "worker-a", "completed", "/tmp/a.jsonl"));
		await settle();

		const snap = store.getSnapshot();
		const row = snap.agents.find(a => a.id === "A");
		expect(row).toBeDefined();
		expect(row?.hasSessionFile).toBe(true);
	});
});

/** Agent-event frame as the daemon forwards it ({ kind: "event" }). */
function agentEvent(type: string, extra: Record<string, unknown> = {}) {
	return { kind: "event", seq: 0, payload: { type, ...extra } };
}

describe("GuiSessionStore working-state machine (stop capsule)", () => {
	it("keeps working through mid-run turn boundaries and retires only at agent_end", async () => {
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");

		// User message lands → capsule on immediately.
		store.apply(
			agentEvent("message_start", {
				message: { role: "user", content: [], timestamp: Date.now() },
			}),
		);
		await settle();
		expect(store.getSnapshot().working).toBe(true);

		// Round 1 ends (assistant reply carried tool calls). turn_end fires
		// per tool batch INSIDE the run — the capsule must NOT flip back to
		// send while the next round's provider prep is in flight.
		store.apply(
			agentEvent("turn_end", {
				message: { role: "assistant", content: [], timestamp: Date.now() },
				toolResults: [],
			}),
		);
		await settle();
		expect(store.getSnapshot().working).toBe(true);

		// Round 2 opens, then the run finishes for real.
		store.apply(agentEvent("turn_start"));
		await settle();
		expect(store.getSnapshot().working).toBe(true);

		store.apply(
			agentEvent("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", timestamp: Date.now() }],
			}),
		);
		await settle();
		expect(store.getSnapshot().working).toBe(false);
	});

	it("still honors authoritative state frames after an abort without turn_end", async () => {
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");
		store.apply(agentEvent("turn_start"));
		await settle();
		expect(store.getSnapshot().working).toBe(true);

		store.apply({ kind: "state", seq: 0, payload: { isStreaming: false } });
		await settle();
		expect(store.getSnapshot().working).toBe(false);
	});
});
