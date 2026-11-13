import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import {
	activityVerbForTool,
	agentSignalsFromSnapshot,
	BORED_AFTER_MS,
	DROWSY_AFTER_MS,
} from "../src/lib/agent-signals";
import { companionStateFromSignals } from "../src/lib/companion";

describe("activityVerbForTool", () => {
	test("maps the tool families Aora knows", () => {
		expect(activityVerbForTool("grep")).toBe("searching");
		expect(activityVerbForTool("web_search")).toBe("searching");
		expect(activityVerbForTool("read")).toBe("reading");
		expect(activityVerbForTool("edit")).toBe("writing");
		expect(activityVerbForTool("bash")).toBe("running-commands");
		expect(activityVerbForTool("browser")).toBe("browsing");
		expect(activityVerbForTool("computer")).toBe("using-computer");
		expect(activityVerbForTool("message")).toBe("messaging");
		expect(activityVerbForTool("upload")).toBe("uploading");
		expect(activityVerbForTool("tts")).toBe("dictating");
		expect(activityVerbForTool("unknown_tool")).toBe("working");
		expect(activityVerbForTool(null)).toBe("working");
	});
});

describe("agentSignalsFromSnapshot", () => {
	test("derives the session layer without inventing one-shots", () => {
		const signals = agentSignalsFromSnapshot({
			working: true,
			streaming: false,
			activeTools: new Map([["t1", { toolName: "grep", startedAt: 1_000 }]]),
			approvals: [],
			agents: [
				{ kind: "main", status: "running" },
				{ kind: "sub", status: "running" },
			],
			state: {
				queuedMessageCount: 2,
				contextUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
				goalMode: { enabled: true, status: "active" },
				todo: [{ name: "ship", done: 1, total: 3 }],
			},
			entries: [],
		});

		expect(signals.phase).toBe("tool");
		expect(signals.activity).toBe("searching");
		expect(signals.toolName).toBe("grep");
		expect(signals.queue).toBe(2);
		expect(signals.subagents?.running).toBe(1);
		expect(signals.context).toEqual({ tokens: 100, window: 1_000, percent: 10 });
		expect(signals.goal).toEqual({ enabled: true, status: "active", done: 1, total: 3 });
		expect(signals.sending).toBeUndefined();
		expect(signals.receiving).toBeUndefined();
	});

	test("paused / approvals / streaming pick the phase", () => {
		expect(agentSignalsFromSnapshot({ state: { paused: true } }).phase).toBe("paused");
		expect(agentSignalsFromSnapshot({ approvals: [{}] }).phase).toBe("awaiting-user");
		expect(agentSignalsFromSnapshot({ streaming: true }).phase).toBe("streaming");
		expect(agentSignalsFromSnapshot({ working: true }).phase).toBe("thinking");
		expect(agentSignalsFromSnapshot({}).phase).toBe("idle");
	});

	test("idleMs comes from the newest entry / tool start", () => {
		const entry = { type: "message", message: { timestamp: 9_000 } } as unknown as SessionEntry;
		expect(agentSignalsFromSnapshot({ entries: [entry] }, { now: 10_000 }).idleMs).toBe(1_000);
		expect(
			agentSignalsFromSnapshot(
				{ activeTools: new Map([["t", { toolName: "bash", startedAt: 8_000 }]]) },
				{ now: 10_000 },
			).idleMs,
		).toBe(2_000);
	});

	test("extras pass through untouched", () => {
		const signals = agentSignalsFromSnapshot(
			{},
			{
				unread: 3,
				interaction: "poke",
				outcome: { kind: "success", at: 1 },
				personaMood: "sad",
				visible: true,
			},
		);
		expect(signals.unread).toBe(3);
		expect(signals.interaction).toBe("poke");
		expect(signals.outcome?.kind).toBe("success");
		expect(signals.personaMood).toBe("sad");
		expect(signals.visible).toBe(true);
	});
});

describe("companionStateFromSignals — richer facts", () => {
	test("activity splits reading from writing and generic work", () => {
		expect(companionStateFromSignals({ phase: "tool", activity: "reading" })).toBe("searching");
		expect(companionStateFromSignals({ phase: "tool", activity: "writing" })).toBe("writing");
		expect(companionStateFromSignals({ phase: "tool", activity: "working" })).toBe("working");
	});

	test("outcome and goal drive the result states", () => {
		expect(companionStateFromSignals({ outcome: { kind: "success", at: 0 } })).toBe("celebrate");
		expect(companionStateFromSignals({ goal: { enabled: true, done: 1, total: 1 } })).toBe("proud");
		expect(companionStateFromSignals({ outcome: { kind: "failure", at: 0 } })).toBe("alerting");
		expect(companionStateFromSignals({ interaction: "deny" })).toBe("confused");
	});

	test("presence and interactions keep the legacy lifecycle states", () => {
		expect(companionStateFromSignals({ presence: "starting" })).toBe("spawning");
		expect(companionStateFromSignals({ presence: "closing" })).toBe("powering-down");
		expect(companionStateFromSignals({ presence: "hidden" })).toBe("drowsy");
		expect(companionStateFromSignals({ interaction: "bounce" })).toBe("bouncing");
		expect(companionStateFromSignals({ interaction: "hum" })).toBe("humming");
	});

	test("questions are curious; approvals are notifying", () => {
		expect(companionStateFromSignals({ questions: 1 })).toBe("curious");
		expect(companionStateFromSignals({ approvals: 1 })).toBe("notifying");
	});

	test("idle thresholds are distinct", () => {
		expect(companionStateFromSignals({ idleMs: BORED_AFTER_MS })).toBe("idle");
		expect(companionStateFromSignals({ idleMs: DROWSY_AFTER_MS })).toBe("drowsy");
	});
});
