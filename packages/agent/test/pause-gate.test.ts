import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@musepi/omptype";
import { AgentPauseGate, agentLoop, agentPauseGate } from "@musepi/pi-agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@musepi/pi-agent-core/types";
import type { Message } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeEchoTool(executed: string[]): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			executed.push(params.msg);
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

describe("agentPauseGate", () => {
	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	it("holds the next model call while paused and releases it on resume", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		expect(agentPauseGate.pause()).toBe(true);
		expect(agentPauseGate.pause()).toBe(false); // already engaged

		const result = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream).result();
		await Bun.sleep(20);
		expect(mock.calls.length).toBe(0); // parked before the first provider call

		expect(agentPauseGate.resume()).toBeGreaterThanOrEqual(0);
		const messages = await result;
		expect(mock.calls.length).toBe(1);
		expect(messages[messages.length - 1].role).toBe("assistant");
	});

	it("holds tool execution at the tool boundary when paused mid-turn", async () => {
		const executed: string[] = [];
		// Signal exactly when the loop parks on the gate. A test-local manual
		// patch (not vi.spyOn) so a sibling file's restoreAllMocks cannot remove
		// it, and a gate regression that never parks hangs this await (test
		// timeout) instead of racing past a vacuous assertion.
		const toolBoundary = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			toolBoundary.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		const mock = createMockModel({
			responses: [
				() => {
					// Engage the gate while the model response is being produced: the
					// turn's tool batch must park before the tool starts.
					agentPauseGate.pause();
					return { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "frozen" } }] };
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [makeEchoTool(executed)] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		try {
			const result = agentLoop([createUserMessage("run echo")], context, config, undefined, mock.stream).result();
			await toolBoundary.promise;
			expect(executed).toEqual([]); // tool parked, not started
			expect(mock.calls.length).toBe(1); // and no follow-up model call either

			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["frozen"]);
			expect(mock.calls.length).toBe(2);
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("lets an external abort unwind a parked run without releasing the gate", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const abortController = new AbortController();

		agentPauseGate.pause();
		const result = agentLoop(
			[createUserMessage("hi")],
			context,
			config,
			abortController.signal,
			mock.stream,
		).result();
		await Bun.sleep(20);
		abortController.abort("user interrupt");

		// The run must terminate as aborted promptly (not stay parked until
		// resume). The provider request itself carries the aborted signal, so
		// whether the transport is entered at all is an implementation detail.
		const messages = await result;
		const last = messages[messages.length - 1];
		expect(last.role).toBe("assistant");
		if (last.role === "assistant") {
			expect(last.stopReason).toBe("aborted");
		}
		expect(agentPauseGate.paused).toBe(true); // aborting one run never resumes the process
	});

	it("re-parks a waiter when the gate is re-engaged in the same tick as resume", async () => {
		agentPauseGate.pause();
		let released = false;
		const waiter = agentPauseGate.waitUntilResumed().then(() => {
			released = true;
		});

		agentPauseGate.resume();
		agentPauseGate.pause(); // re-engage before the waiter's microtask runs
		await Bun.sleep(10);
		expect(released).toBe(false);

		agentPauseGate.resume();
		await waiter;
		expect(released).toBe(true);
	});

	it("reports pause state transitions to onChange subscribers", () => {
		const transitions: boolean[] = [];
		const unsubscribe = agentPauseGate.onChange(paused => transitions.push(paused));
		agentPauseGate.pause();
		agentPauseGate.resume();
		unsubscribe();
		agentPauseGate.pause();
		agentPauseGate.resume();
		expect(transitions).toEqual([true, false]);
	});

	it("parks on a config-provided per-scope gate without touching the global gate", async () => {
		// Multi-scope hosts (the GUI daemon) pass their own gate per session:
		// engaging it must freeze that run while the process-global gate (and
		// any other scope's run) keeps flowing.
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const scopeGate = new AgentPauseGate();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, pauseGate: scopeGate };

		expect(scopeGate.pause()).toBe(true);
		expect(agentPauseGate.paused).toBe(false); // global gate untouched

		// The park is promise-driven inside the async loop — there is no
		// event to await that proves the loop reached the boundary, so give
		// the loop a few macrotasks to get there (integration-style timing).
		const result = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream).result();
		await Bun.sleep(20);
		expect(mock.calls.length).toBe(0); // parked on the scope gate

		// The global gate alone must NOT release a scope-gated run…
		agentPauseGate.pause();
		agentPauseGate.resume();
		await Bun.sleep(20);
		expect(mock.calls.length).toBe(0);

		// …only the scope's own resume does.
		expect(scopeGate.resume()).toBeGreaterThanOrEqual(0);
		const messages = await result;
		expect(mock.calls.length).toBe(1);
		expect(messages[messages.length - 1].role).toBe("assistant");
	});

	it("checks the global gate even when a per-scope gate is configured, and keeps the scope park after a global release", async () => {
		// Daemon-wide pause engages the process-global gate; every loop must
		// consult it FIRST regardless of its own scope gate (otherwise the
		// global pause would freeze nothing in the daemon, where every loop
		// carries a per-session gate). The gates are orthogonal: releasing the
		// global pause must not release a session that is itself paused.
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const scopeGate = new AgentPauseGate();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, pauseGate: scopeGate };

		// Global engaged: the scope-gated run must park on the GLOBAL gate.
		expect(agentPauseGate.pause()).toBe(true);
		// Real delay: the park is promise-driven inside the async loop with
		// no observable event until it resolves — integration-style timing.
		const result = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream).result();
		await Bun.sleep(20);
		expect(mock.calls.length).toBe(0); // parked on the global gate

		// Both gates engaged now — releasing the global one wakes the loop
		// only as far as the scope gate, which stays engaged.
		scopeGate.pause();
		agentPauseGate.resume();
		await Bun.sleep(20);
		expect(mock.calls.length).toBe(0); // still parked on the scope gate

		// Re-engage the global gate while the loop waits on the scope one —
		// a later global release alone must still not release it.
		agentPauseGate.pause();
		agentPauseGate.resume();
		await Bun.sleep(20);
		expect(mock.calls.length).toBe(0);

		expect(scopeGate.resume()).toBeGreaterThanOrEqual(0);
		const messages = await result;
		expect(mock.calls.length).toBe(1);
		expect(messages[messages.length - 1].role).toBe("assistant");
	});
});
