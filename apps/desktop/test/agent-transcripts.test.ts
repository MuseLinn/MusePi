// Live subagent transcripts: frames stream in per agent, history seeds once,
// and the two never double up on one message.
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentEvent, SessionEntry } from "@musepi/pi-wire";
import {
	agentTranscriptEntries,
	applyAgentEvent,
	isAgentTranscriptSeeded,
	retainAgentTranscript,
	seedAgentTranscript,
} from "../src/lib/agent-transcripts";

const releases: (() => void)[] = [];
function retain(agentId: string): void {
	releases.push(retainAgentTranscript(agentId));
}
afterEach(() => {
	while (releases.length > 0) releases.pop()?.();
});

function assistant(ts: number, text: string): AgentEvent {
	return {
		type: "message_start",
		message: { role: "assistant", timestamp: ts, content: [{ type: "text", text }] },
	} as unknown as AgentEvent;
}

function assistantUpdate(ts: number, text: string): AgentEvent {
	return {
		type: "message_update",
		message: { role: "assistant", timestamp: ts, content: [{ type: "text", text }] },
	} as unknown as AgentEvent;
}

function userEntry(ts: number, text: string): SessionEntry {
	return {
		type: "message",
		id: `user:${ts}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", timestamp: ts, content: [{ type: "text", text }] },
	} as unknown as SessionEntry;
}

describe("agent transcripts", () => {
	test("frames for an agent nobody watches are dropped", () => {
		applyAgentEvent("never-retained", assistant(1, "hello"));
		expect(agentTranscriptEntries("never-retained")).toEqual([]);
	});

	test("a streamed message lands as one row and updates in place", () => {
		retain("a1");
		applyAgentEvent("a1", assistant(1000, "first"));
		applyAgentEvent("a1", assistantUpdate(1000, "first, then more"));

		const rows = agentTranscriptEntries("a1");
		expect(rows).toHaveLength(1);
		// The second frame is a content update, not a second message — this is
		// what stops a streaming turn from stacking rows.
		expect(JSON.stringify(rows[0]!.message)).toContain("first, then more");
	});

	test("seeded history and a live frame for the same message collapse onto one row", () => {
		retain("a2");
		// History arrives rekeyed to view space, exactly as the daemon's
		// snapshot path produces it: `role:timestamp`.
		seedAgentTranscript("a2", [userEntry(2000, "do the thing")]);
		expect(agentTranscriptEntries("a2")).toHaveLength(1);

		// The same message streaming in must replace, not duplicate.
		applyAgentEvent("a2", {
			type: "message_update",
			message: { role: "user", timestamp: 2000, content: [{ type: "text", text: "do the thing" }] },
		} as unknown as AgentEvent);

		expect(agentTranscriptEntries("a2")).toHaveLength(1);
	});

	test("seeding twice is a no-op so a retried read cannot duplicate history", () => {
		retain("a3");
		seedAgentTranscript("a3", [userEntry(3000, "one")]);
		seedAgentTranscript("a3", [userEntry(3000, "one")]);

		expect(agentTranscriptEntries("a3")).toHaveLength(1);
		expect(isAgentTranscriptSeeded("a3")).toBe(true);
	});

	test("retaining an agent resets its projection", () => {
		retain("a4");
		applyAgentEvent("a4", assistant(4000, "before"));
		expect(agentTranscriptEntries("a4")).toHaveLength(1);

		// Release and re-retain: a reopened view starts from history again
		// rather than replaying what the previous mount already saw.
		releases.pop()?.();
		retain("a4");
		expect(agentTranscriptEntries("a4")).toEqual([]);
		expect(isAgentTranscriptSeeded("a4")).toBe(false);
	});
});
