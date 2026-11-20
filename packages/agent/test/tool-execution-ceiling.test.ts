import { describe, expect, it } from "bun:test";
import { type } from "@musepi/musepi-type";
import { agentLoop } from "@musepi/pi-agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@musepi/pi-agent-core/types";
import type { Message } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

/**
 * Contract (per-tool execution ceiling): a tool that declares `timeoutMs` can
 * never hold the turn past that ceiling. The loop abandons the execution,
 * aborts the per-call signal it handed the tool, and settles ONE timeout error
 * result — then the turn continues, so the model can react (retry another path,
 * report the failure) instead of the session sitting silent forever. Tools
 * without a ceiling (human waits, self-bounded executions) keep waiting by
 * declaration.
 */
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const toolSchema = type({ value: "string" });

function hangingTool(state: { aborted: boolean }, timeoutMs: number): AgentTool<typeof toolSchema> {
	return {
		name: "hung",
		label: "Hung",
		description: "Never settles on its own",
		parameters: toolSchema,
		timeoutMs,
		async execute(_toolCallId, _params, signal) {
			return await new Promise<never>((_, reject) => {
				signal?.addEventListener("abort", () => {
					state.aborted = true;
					reject(new Error("aborted"));
				});
			});
		},
	};
}

describe("per-tool execution ceiling", () => {
	it("abandons an over-running tool, aborts it, and keeps the turn going", async () => {
		const state = { aborted: false };
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [hangingTool(state, 25)] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "hung-1", name: "hung", arguments: { value: "x" } }] },
				{ content: ["recovered"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run it")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		const ends = events.filter(e => e.type === "tool_execution_end");
		expect(ends).toHaveLength(1);
		if (ends[0]?.type !== "tool_execution_end") throw new Error("expected tool_execution_end");
		expect(ends[0].isError).toBe(true);
		const firstBlock = ends[0].result.content[0];
		expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("timed out");

		// The tool learned about the abandon instead of leaking its work.
		expect(state.aborted).toBe(true);
		// The model was asked again after the timeout: the turn is not stuck.
		expect(mock.calls).toHaveLength(2);
		expect(messages.filter(m => m.role === "assistant")).toHaveLength(2);
	}, 10_000);
});
