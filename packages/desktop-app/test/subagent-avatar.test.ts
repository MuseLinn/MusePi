import "./dom-shim";
import { describe, expect, test } from "bun:test";
import type { AgentSnapshot, SubagentProgressPayload } from "@musepi/pi-wire";
import { orbStateForSubagent, subagentSignals } from "../src/components/SubagentAvatar";

const agent = (status: AgentSnapshot["status"]): AgentSnapshot => ({
	id: "sub-1",
	displayName: "Researcher",
	kind: "sub",
	parentId: "main",
	status,
	hasSessionFile: true,
	createdAt: 1,
	lastActivity: 2,
});

const payload = (progress: Record<string, unknown>): SubagentProgressPayload =>
	({ progress }) as unknown as SubagentProgressPayload;

describe("subagentSignals", () => {
	test("a running tool becomes a tool presence with its activity verb", () => {
		const signals = subagentSignals(agent("running"), payload({ currentTool: "grep", status: "running" }), 10);
		expect(signals).toMatchObject({ phase: "tool", activity: "searching", toolName: "grep", working: true });
	});

	test("a parked approval is attention, not work", () => {
		expect(subagentSignals(agent("running"), payload({ awaitingApproval: true, currentTool: "bash" }))).toMatchObject(
			{
				phase: "awaiting-user",
				approvals: 1,
				toolName: "bash",
			},
		);
	});

	test("completed, failed and parked map to their result/lifecycle states", () => {
		expect(subagentSignals(agent("idle"), payload({ status: "completed" }))).toMatchObject({
			justFinished: true,
			outcome: { kind: "success" },
		});
		expect(subagentSignals(agent("aborted"), payload({ status: "failed" }))).toMatchObject({
			phase: "error",
			toolFailed: true,
		});
		expect(subagentSignals(agent("parked"))).toMatchObject({ phase: "paused" });
		expect(subagentSignals(agent("idle"))).toMatchObject({ phase: "idle" });
	});

	test("the classic orb projection follows the same reading", () => {
		expect(orbStateForSubagent({ approvals: 1 })).toBe("waiting");
		expect(orbStateForSubagent({ phase: "streaming" })).toBe("composing");
		expect(orbStateForSubagent({ phase: "tool", activity: "searching" })).toBe("searching");
		expect(orbStateForSubagent({ phase: "thinking" })).toBe("solving");
		expect(orbStateForSubagent({ phase: "idle" })).toBe("listening");
	});
});
