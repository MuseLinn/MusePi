/**
 * A tool call that started and never recorded a result was cut off by an exited
 * process, not by a branch boundary. Recovery must show it as an unknown
 * outcome: deleting it tells the model the call never ran, so it re-issues the
 * same write against a world that already changed. A call that never started
 * (its result sits on a sibling branch) stays stripped — replaying it would
 * re-inject a batch the user deliberately left behind.
 */
import { describe, expect, it } from "bun:test";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "../../src/session/exit-diagnostics";
import { buildSessionContext } from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";

const stamp = new Date().toISOString();

function base(id: string, parentId: string | null) {
	return { id, parentId, timestamp: stamp };
}

function path(started: boolean): SessionEntry[] {
	const entries: SessionEntry[] = [
		{
			...base("u1", null),
			type: "message",
			message: { role: "user", content: "rewrite the config", timestamp: 1 },
		} as unknown as SessionEntry,
		{
			...base("a1", "u1"),
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
				timestamp: 2,
			},
		} as unknown as SessionEntry,
	];
	if (started) {
		entries.push({
			...base("c1", "a1"),
			type: "custom",
			customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
			data: { toolCallId: "call-1", toolName: "write", startedAt: stamp },
		} as unknown as SessionEntry);
	}
	return entries;
}

function context(started: boolean) {
	const entries = path(started);
	const leafId = started ? "c1" : "a1";
	return buildSessionContext(entries, leafId).messages;
}

describe("interrupted tool calls on recovery", () => {
	it("keeps a started call and gives it an unknown outcome", () => {
		const messages = context(true);
		const assistant = messages.find(message => message.role === "assistant");
		expect(JSON.stringify(assistant)).toContain("call-1");

		const result = messages.find(message => message.role === "toolResult");
		expect(result?.toolCallId).toBe("call-1");
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("may already have run");
	});

	it("still strips a call that never started", () => {
		const messages = context(false);
		expect(JSON.stringify(messages)).not.toContain("call-1");
		expect(messages.some(message => message.role === "toolResult")).toBe(false);
	});
});
