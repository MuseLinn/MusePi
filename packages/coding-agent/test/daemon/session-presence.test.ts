import { describe, expect, test } from "bun:test";
import { deriveSessionPresence, type SessionPresenceLive } from "../../src/daemon/session-presence";

const row = { sessionId: "s1", updatedAt: "2026-01-01T00:00:00.000Z" };

function live(overrides: Partial<SessionPresenceLive> = {}): SessionPresenceLive {
	return {
		agentSession: { isStreaming: false },
		view: { snapshot: () => ({ state: { isStreaming: false } }) },
		activeToolCalls: new Map(),
		approvals: { pending: new Map(), pendingAsks: new Map() },
		pauseGate: { paused: false },
		...overrides,
	};
}

describe("deriveSessionPresence", () => {
	test("idle live session", () => {
		expect(deriveSessionPresence(live(), row)).toMatchObject({
			phase: "idle",
			working: false,
			live: true,
			pendingApprovals: 0,
			pendingQuestions: 0,
			activeTool: null,
		});
	});

	test("streaming and tool phases keep working true", () => {
		expect(deriveSessionPresence(live({ agentSession: { isStreaming: true } }), row)).toMatchObject({
			phase: "streaming",
			working: true,
		});
		expect(
			deriveSessionPresence(live({ activeToolCalls: new Map([["t", { toolName: "grep" }]]) }), row),
		).toMatchObject({ phase: "tool", activeTool: "grep", working: true });
	});

	test("approvals outrank questions, tools and streaming", () => {
		const base = live({
			agentSession: { isStreaming: true },
			activeToolCalls: new Map([["t", { toolName: "bash" }]]),
		});
		expect(
			deriveSessionPresence(
				{ ...base, approvals: { pending: new Map([["a", {}]]), pendingAsks: new Map([["q", {}]]) } },
				row,
			).phase,
		).toBe("awaiting-approval");
		expect(
			deriveSessionPresence({ ...base, approvals: { pending: new Map(), pendingAsks: new Map([["q", {}]]) } }, row)
				.phase,
		).toBe("awaiting-input");
	});

	test("compaction and pause are explicit", () => {
		expect(deriveSessionPresence(live({ agentSession: { isCompacting: true } }), row).phase).toBe("compacting");
		expect(
			deriveSessionPresence(
				live({ pauseGate: { paused: true }, approvals: { pending: new Map([["a", {}]]), pendingAsks: new Map() } }),
				row,
			),
		).toMatchObject({ phase: "paused", working: false, pendingApprovals: 1 });
	});

	test("a non-live row degrades to its persisted status", () => {
		expect(deriveSessionPresence(undefined, { ...row, status: "error" })).toMatchObject({
			phase: "error",
			live: false,
			working: false,
		});
		expect(deriveSessionPresence(undefined, { ...row, status: "complete" })).toMatchObject({
			phase: "idle",
			live: false,
		});
	});
});
