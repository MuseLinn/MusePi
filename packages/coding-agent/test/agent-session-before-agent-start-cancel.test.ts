import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@musepi/pi-agent-core";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { buildModel } from "@musepi/pi-catalog/build";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@musepi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

// Contract: a `before_agent_start` handler may refuse the prompt (command hooks
// need a `UserPromptSubmit` gate). The refusal must happen BEFORE anything is
// sent or persisted, and the reason is user-facing — the plugin that refused
// owns its presentation.

function createModel() {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

describe("AgentSession before_agent_start cancellation", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	function createSession(cancel: boolean): { sent: { count: number } } {
		const sent = { count: 0 };
		const mock = createMockModel({ responses: [{ content: ["should not run"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: createModel(), systemPrompt: ["base"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (model, context, streamOptions) => {
				sent.count += 1;
				return mock.stream(model, context, streamOptions);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: {
				emitBeforeAgentStart: async () =>
					cancel ? { cancelled: true, reason: "Blocked by a UserPromptSubmit hook." } : undefined,
				emit: async () => undefined,
			} as unknown as ExtensionRunner,
		});
		return { sent };
	}

	it("does not send or persist a refused prompt, and hands it back to the host", async () => {
		const { sent } = createSession(true);
		const dropped: Array<{ text: string }> = [];
		session!.setPromptDropped(prompt => dropped.push({ text: prompt.text }));
		await session!.prompt("hello");
		expect(sent.count).toBe(0);
		expect(session!.messages).toEqual([]);
		expect(dropped).toEqual([{ text: "hello" }]);
	});

	it("still sends when no handler refuses", async () => {
		const { sent } = createSession(false);
		await session!.prompt("hello");
		expect(sent.count).toBeGreaterThan(0);
	});
});
