import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "../src/types.js";
import { Agent } from "../src/agent.js";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@musepi/pi-ai/utils/event-stream";

describe("optimistic user-message emit", () => {
	it("emits the user message before agent_start and never duplicates it", async () => {
		const mock = createMockModel({ responses: [{ content: ["Hi there!"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("hello");

		// Optimistic emit: the user's own message lands synchronously at
		// prompt() time — before any provider preparation — so the GUI bubble /
		// TUI transcript appear instantly instead of waiting for the turn.
		expect(events[0]).toMatchObject({ type: "message_start" });
		expect(events[0]?.type === "message_start" && events[0].message.role).toBe("user");
		expect(events[1]?.type).toBe("message_end");
		expect(events[1]?.type === "message_end" && events[1].message.role).toBe("user");

		const userStarts = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_start" }> =>
				e.type === "message_start" && e.message.role === "user",
		);
		const userEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "user",
		);
		const agentStartIdx = events.findIndex(e => e.type === "agent_start");
		const userStartIdx = events.findIndex(
			e => e.type === "message_start" && e.message.role === "user",
		);

		// Exactly one of each — the run loop must not re-broadcast the
		// pre-emitted message objects.
		expect(userStarts).toHaveLength(1);
		expect(userEnds).toHaveLength(1);
		expect(userStartIdx).toBeGreaterThan(-1);
		expect(userStartIdx).toBeLessThan(agentStartIdx);

		// State/context still sees the message exactly once (appended by the
		// loop's own message_end handling, not by the optimistic emit).
		expect(agent.state.messages.map(m => m.role)).toEqual(["user", "assistant"]);
		unsubscribe();
	});

	it("keeps the error lifecycle intact when the provider fails", async () => {
		const mock = createMockModel({ responses: [] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(new Error("boom")));
				return stream;
			},
		});
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("hello");

		// The optimistic user message still fired exactly once, and the
		// assistant error lifecycle follows the same shape as before.
		const userStarts = events.filter(
			e => e.type === "message_start" && e.message.role === "user",
		).length;
		expect(userStarts).toBe(1);
		const assistantEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "assistant",
		);
		const assistant = assistantEnd?.message as unknown as { stopReason?: string; errorMessage?: string };
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toBe("boom");
		unsubscribe();
	});
});
