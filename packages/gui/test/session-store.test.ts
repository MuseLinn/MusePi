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
