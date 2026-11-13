import { describe, expect, test } from "bun:test";
import { type AgentSignals, BORED_AFTER_MS, DROWSY_AFTER_MS, SLEEPING_AFTER_MS } from "../src/lib/agent-signals";
import { AORA_STATE_SOURCE, AORA_STATES, type AoraState, aoraStateFromSignals } from "../src/lib/aora-state";

/**
 * One honest producer per Aora state. If a state has no entry here, it is a
 * dead state — the exact failure mode the old 31-state axis had.
 */
const REACHABLE: Array<[AoraState, AgentSignals]> = [
	["idle", {}],
	["sleeping", { presence: "hidden" }],
	["drowsy", { idleMs: DROWSY_AFTER_MS }],
	["bored", { idleMs: BORED_AFTER_MS }],
	["waking", { presence: "waking" }],
	["powering-down", { presence: "closing" }],
	["listening", { interaction: "listening" }],
	["thinking", { phase: "thinking" }],
	["searching", { phase: "tool", activity: "searching" }],
	["reading", { phase: "tool", activity: "reading" }],
	["writing", { phase: "tool", activity: "writing" }],
	["working", { phase: "tool", activity: "working" }],
	["loading", { historyLoading: true }],
	["progress", { phase: "tool", activity: "working", startedAt: 1_000, now: 12_000 }],
	["radar", { phase: "tool", activity: "connecting" }],
	["orbit", { phase: "tool", subagents: { running: 2, parked: 0, completed: 0, failed: 0 } }],
	["dictating", { phase: "tool", activity: "dictating" }],
	["uploading", { phase: "tool", activity: "uploading" }],
	["sending", { sending: true }],
	["receiving", { receiving: true }],
	["messaging", { phase: "tool", activity: "messaging" }],
	["waiting", { approvals: 1 }],
	["spawning", { presence: "starting" }],
	["composing", { phase: "streaming" }],
	["dragging", { interaction: "drag" }],
	["happy", { outcome: { kind: "success", at: 0 } }],
	["excited", { personaMood: "excited" }],
	["laughing", { personaMood: "laughing" }],
	["playful", { interaction: "play" }],
	["proud", { goal: { enabled: true, done: 1, total: 1 } }],
	["celebrate", { outcome: { kind: "success", at: 0 }, justFinished: true }],
	["bouncing", { interaction: "bounce" }],
	["shy", { interaction: "praise" }],
	["sad", { personaMood: "sad" }],
	["angry", { personaMood: "angry" }],
	["confused", { ambiguous: true }],
	["suspicious", { personaMood: "suspicious" }],
	["surprised", { interaction: "poke" }],
	["scared", { personaMood: "scared" }],
	["curious", { questions: 1 }],
	["humming", { interaction: "hum" }],
	["alerting", { outcome: { kind: "failure", at: 0 } }],
	["notifying", { unread: 1 }],
	["refusing", { interaction: "deny" }],
];

describe("Aora state vocabulary", () => {
	test("44 unique states, exactly as the engine publishes them", () => {
		expect(AORA_STATES.length).toBe(44);
		expect(new Set(AORA_STATES).size).toBe(44);
		expect(AORA_STATES).toContain("powering-down");
		expect(AORA_STATES).toContain("dictating");
		expect(AORA_STATES).toContain("refusing");
	});

	test("every state declares which layer can produce it", () => {
		expect(Object.keys(AORA_STATE_SOURCE).length).toBe(44);
		for (const state of AORA_STATES) {
			expect(["session", "outcome", "presence", "persona"]).toContain(AORA_STATE_SOURCE[state]);
		}
		expect(AORA_STATE_SOURCE.working).toBe("session");
		expect(AORA_STATE_SOURCE.celebrate).toBe("outcome");
		expect(AORA_STATE_SOURCE.dragging).toBe("presence");
		expect(AORA_STATE_SOURCE.sad).toBe("persona");
	});

	test("the documented producer split is exact", () => {
		const counts = Object.values(AORA_STATE_SOURCE).reduce<Record<string, number>>((acc, source) => {
			acc[source] = (acc[source] ?? 0) + 1;
			return acc;
		}, {});
		expect(counts).toEqual({ session: 19, outcome: 4, presence: 12, persona: 9 });
	});

	test("every state is reachable from a real signal — no dead states", () => {
		const mismatches = REACHABLE.filter(
			([state, signals]) => aoraStateFromSignals(signals, "assistant") !== state,
		).map(([state, signals]) => `${state} -> ${aoraStateFromSignals(signals, "assistant")}`);
		expect(mismatches).toEqual([]);
	});
});

describe("aoraStateFromSignals — priority and surface", () => {
	test("failure / approvals / paused outrank live work", () => {
		expect(aoraStateFromSignals({ outcome: { kind: "failure", at: 0 }, phase: "tool", activity: "searching" })).toBe(
			"alerting",
		);
		expect(aoraStateFromSignals({ approvals: 1, phase: "tool", activity: "searching" })).toBe("waiting");
		expect(aoraStateFromSignals({ phase: "paused", working: true, activity: "searching" })).toBe("waiting");
	});

	test("streaming outranks an ambient tool", () => {
		expect(aoraStateFromSignals({ phase: "streaming", activity: "searching" })).toBe("composing");
	});

	test("workbench never shows persona states", () => {
		expect(aoraStateFromSignals({ personaMood: "sad" }, "assistant")).toBe("sad");
		expect(aoraStateFromSignals({ personaMood: "sad" }, "workbench")).toBe("idle");
		expect(aoraStateFromSignals({ personaMood: "angry" }, "workbench")).toBe("idle");
		expect(aoraStateFromSignals({ personaMood: "scared" }, "workbench")).toBe("idle");
		expect(aoraStateFromSignals({ personaMood: "playful" }, "workbench")).toBe("idle");
		expect(aoraStateFromSignals({ interaction: "play" }, "workbench")).toBe("idle");
	});

	test("workbench keeps neutral outcome signals", () => {
		expect(aoraStateFromSignals({ outcome: { kind: "failure", at: 0 } }, "workbench")).toBe("alerting");
		expect(aoraStateFromSignals({ interaction: "deny" }, "workbench")).toBe("refusing");
		expect(aoraStateFromSignals({ approvals: 1 }, "workbench")).toBe("waiting");
	});

	test("avatar is a compact projection", () => {
		expect(aoraStateFromSignals({ approvals: 1 }, "avatar")).toBe("waiting");
		expect(aoraStateFromSignals({ outcome: { kind: "failure", at: 0 } }, "avatar")).toBe("alerting");
		expect(aoraStateFromSignals({ phase: "tool", activity: "searching" }, "avatar")).toBe("searching");
		expect(aoraStateFromSignals({ personaMood: "sad" }, "avatar")).toBe("idle");
	});

	test("idle thresholds are ordered sleeping > drowsy > bored > idle", () => {
		expect(aoraStateFromSignals({ idleMs: SLEEPING_AFTER_MS })).toBe("sleeping");
		expect(aoraStateFromSignals({ idleMs: DROWSY_AFTER_MS })).toBe("drowsy");
		expect(aoraStateFromSignals({ idleMs: BORED_AFTER_MS })).toBe("bored");
		expect(aoraStateFromSignals({})).toBe("idle");
	});
});
