/**
 * Unit tests for the materialized view projection (@musepi/sdk
 * materialized-view.ts, shared by the daemon and browser clients).
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent, UserMessage } from "@musepi/pi-wire";
import { MaterializedView } from "@musepi/sdk";

const SESSION = "test-session";
const CWD = "/tmp/project";

function userMessage(overrides: Partial<UserMessage> = {}): UserMessage {
	return {
		role: "user",
		content: "hello",
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

describe("MaterializedView message projection", () => {
	test("message_start creates a MessageEntry; update/end mutate it, never duplicate", () => {
		const view = new MaterializedView(SESSION, CWD);
		const msg = userMessage();
		view.apply({ type: "message_start", message: msg });
		view.apply({ type: "message_update", message: { ...msg, content: "hel" } });
		view.apply({ type: "message_end", message: { ...msg, content: "hello!" } });

		const snap = view.snapshot();
		expect(snap.entries).toHaveLength(1);
		expect(snap.entries[0]!.type).toBe("message");
		const entry = snap.entries[0] as { message: UserMessage };
		// end carries the final accumulating message
		expect(entry.message.content).toBe("hello!");
	});

	test("message updates REPLACE the entry object (new reference) so memoized rows re-render", () => {
		const view = new MaterializedView(SESSION, CWD);
		const msg = userMessage();
		view.apply({ type: "message_start", message: msg });
		const first = view.snapshot().entries[0];
		// An update to the same message must yield a NEW entry object —
		// the GUI transcript memoizes rows on the entry reference and
		// renders the entry as the single live stream row (no ghost).
		view.apply({ type: "message_update", message: { ...msg, content: "hel" } });
		const second = view.snapshot().entries[0];
		expect(second).not.toBe(first);
		expect(second).toMatchObject({ type: "message", id: first!.id });
		// Still one entry — replacement, not duplication.
		expect(view.snapshot().entries).toHaveLength(1);
	});

	test("messages with different timestamps are separate entries; toolResult dedupes on toolCallId", () => {
		const view = new MaterializedView(SESSION, CWD);
		view.apply({ type: "message_start", message: userMessage({ timestamp: 1 }) });
		view.apply({ type: "message_start", message: userMessage({ timestamp: 2 }) });
		view.apply({
			type: "message_start",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "echo",
				content: [{ type: "text", text: "r" }],
				isError: false,
				timestamp: 3,
			},
		});
		view.apply({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "echo",
				content: [{ type: "text", text: "r2" }],
				isError: false,
				timestamp: 3,
			},
		});
		const snap = view.snapshot();
		expect(snap.entries).toHaveLength(3);
		// toolResult updated in place, not duplicated
		expect(
			snap.entries.some(
				e =>
					e.type === "message" &&
					e.message.role === "toolResult" &&
					(e.message as { content: { text: string }[] }).content[0]!.text === "r2",
			),
		).toBe(true);
	});

	test("thinking_level_changed appends a ThinkingLevelChangeEntry with a unique id", () => {
		const view = new MaterializedView(SESSION, CWD);
		view.apply({ type: "thinking_level_changed", thinkingLevel: "high" });
		view.apply({ type: "thinking_level_changed" });
		const snap = view.snapshot();
		const tlcs = snap.entries.filter(e => e.type === "thinking_level_change");
		expect(tlcs).toHaveLength(2);
		expect(tlcs[0]).toMatchObject({ type: "thinking_level_change", thinkingLevel: "high" });
		expect(tlcs[1]!.id).not.toBe(tlcs[0]!.id);
	});

	test("agent_start/end drive the main-agent lifecycle; non-wire events are ignored", () => {
		const view = new MaterializedView(SESSION, CWD);
		view.apply({ type: "agent_start" });
		expect(view.snapshot().agents[0]).toMatchObject({ id: "main", kind: "main", status: "running" });
		view.apply({ type: "agent_end" });
		expect(view.snapshot().agents[0]!.status).toBe("idle");
		// events with no projected surface
		view.apply({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: {} });
		view.apply({ type: "notice", level: "info", message: "hi" });
		expect(view.snapshot().entries).toHaveLength(0);
	});

	test("turn_start/end flip state.isStreaming", () => {
		const view = new MaterializedView(SESSION, CWD);
		expect(view.snapshot().state.isStreaming).toBe(false);
		view.apply({ type: "turn_start" });
		expect(view.snapshot().state.isStreaming).toBe(true);
		view.apply({ type: "turn_end" });
		expect(view.snapshot().state.isStreaming).toBe(false);
	});

	test("cursor counts every applied event, including ignored ones", () => {
		const view = new MaterializedView(SESSION, CWD);
		view.apply({ type: "agent_start" });
		view.apply({ type: "turn_start" });
		view.apply({ type: "message_start", message: userMessage() });
		view.apply({ type: "notice", level: "info", message: "n" });
		expect(view.cursor).toBe(4);
		expect(view.snapshot().cursor).toBe(4);
	});

	test("snapshot shape matches the SDK contract (header/entries/state/agents/cursor)", () => {
		const view = new MaterializedView(SESSION, CWD, "2026-08-02T00:00:00.000Z");
		view.apply({ type: "agent_start" });
		view.apply({ type: "message_start", message: userMessage() });
		const snap = view.snapshot();
		expect(snap.header).toMatchObject({
			type: "session",
			id: SESSION,
			cwd: CWD,
			timestamp: "2026-08-02T00:00:00.000Z",
		});
		expect(snap.state.cwd).toBe(CWD);
		expect(Array.isArray(snap.agents)).toBe(true);
		expect(typeof snap.cursor).toBe("number");
	});
});

describe("MaterializedView persistence round-trip", () => {
	test("fromSnapshot restores entries, agents, streaming and cursor", () => {
		const view = new MaterializedView(SESSION, CWD);
		view.apply({ type: "agent_start" });
		view.apply({ type: "message_start", message: userMessage({ content: "keep me" }) });
		view.apply({ type: "turn_start" });

		const restored = MaterializedView.fromSnapshot(SESSION, CWD, view.snapshot());
		expect(restored).not.toBeNull();
		const snap = restored!.snapshot();
		expect(snap.cursor).toBe(3);
		expect(snap.entries).toHaveLength(1);
		expect((snap.entries[0] as { message: UserMessage }).message.content).toBe("keep me");
		expect(snap.state.isStreaming).toBe(true);
		expect(snap.agents[0]!.status).toBe("running");
	});

	test("replay builds the same state as incremental apply", () => {
		const events: AgentEvent[] = [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", message: userMessage() },
			{ type: "message_end", message: userMessage({ content: "final" }) },
			{ type: "turn_end" },
		];
		// agent_start stamps agent.createdAt/lastActivity with Date.now() —
		// freeze the clock so the incremental and replayed views agree.
		const realNow = Date.now;
		Date.now = () => 1_700_000_000_000;
		try {
			const incremental = new MaterializedView(SESSION, CWD);
			for (const e of events) incremental.apply(e);
			const replayed = MaterializedView.replay(SESSION, CWD, events);
			expect(replayed.snapshot()).toEqual(incremental.snapshot());
		} finally {
			Date.now = realNow;
		}
	});

	test("fromSnapshot rejects malformed input", () => {
		expect(MaterializedView.fromSnapshot(SESSION, CWD, null)).toBeNull();
		expect(MaterializedView.fromSnapshot(SESSION, CWD, { entries: "nope" })).toBeNull();
	});
});

describe("MaterializedView TTSR / IRC projection", () => {
	test("ttsr_triggered projects a ttsr custom_message entry with wire rules", () => {
		const view = new MaterializedView(SESSION, CWD);
		view.apply({
			type: "ttsr_triggered",
			rules: [
				{ name: "no-console", description: "不许直接 console.log" },
				{ name: "fence", content: "代码栅栏" },
			],
		});
		const snap = view.snapshot();
		expect(snap.entries).toHaveLength(1);
		const entry = snap.entries[0] as { type: string; customType: string; content: string; details?: unknown };
		expect(entry.type).toBe("custom_message");
		expect(entry.customType).toBe("ttsr");
		expect(entry.content).toBe("no-console、fence");
		expect(entry.details).toEqual({
			rules: [
				{ name: "no-console", description: "不许直接 console.log" },
				{ name: "fence", content: "代码栅栏" },
			],
		});
	});

	test("irc_message projects a custom_message row carrying type/from/message", () => {
		const view = new MaterializedView(SESSION, CWD);
		view.apply({
			type: "irc_message",
			message: {
				role: "custom",
				customType: "irc:incoming",
				content: "sub: 我查一下",
				display: true,
				details: { id: "m1", from: "sub", message: "我查一下" },
				attribution: "agent",
				timestamp: 1_700_000_100_000,
			},
		});
		const snap = view.snapshot();
		expect(snap.entries).toHaveLength(1);
		const entry = snap.entries[0] as { customType: string; content: string; details?: unknown; timestamp: string };
		expect(entry.customType).toBe("irc:incoming");
		expect(entry.content).toBe("sub: 我查一下");
		expect((entry.details as { from: string }).from).toBe("sub");
		expect(entry.timestamp).toBe(new Date(1_700_000_100_000).toISOString());
	});

	test("replay reproduces ttsr/irc entries", () => {
		const events: AgentEvent[] = [
			{ type: "turn_start" },
			{ type: "ttsr_triggered", rules: [{ name: "no-console" }] },
			{
				type: "irc_message",
				message: { role: "custom", customType: "irc:incoming", content: "hi", display: true, timestamp: 5 },
			},
		];
		const incremental = new MaterializedView(SESSION, CWD);
		for (const e of events) incremental.apply(e);
		const replayed = MaterializedView.replay(SESSION, CWD, events);
		expect(replayed.snapshot()).toEqual(incremental.snapshot());
	});
});
