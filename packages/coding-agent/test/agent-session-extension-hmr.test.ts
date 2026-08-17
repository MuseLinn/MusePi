import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@musepi/pi-agent-core";
import type { Model } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { buildModel } from "@musepi/pi-catalog/build";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@musepi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

// P5 HMR v2 busy gate: a session-level extension reload requested while the
// session is streaming must be parked (single pending slot) and performed at
// the next idle agent_end — never half-replacing the tool surface mid-turn.

const ENTRY_PATH = "/extensions/hmr-ext.ts";

// The deferred reload is fire-and-forget (`void` on the agent_end drain), so no
// promise is exposed to await; polling the mock call is the only signal. Bounded
// and race-tolerant (2s cap, 10ms granularity) — deterministic timer control
// cannot work here because the drain runs on the session's real event pipeline.
async function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("pollUntil: condition not met before timeout");
		await Bun.sleep(10);
	}
}

function createModel(): Model<"openai-responses"> {
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

describe("AgentSession extension hot reload busy gate", () => {
	let session: AgentSession | undefined;
	let reloadExtension: ReturnType<typeof vi.fn>;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	function createSession(): { session: AgentSession; agent: Agent } {
		reloadExtension = vi.fn(async () => ({ removedTools: [], errors: [], deferred: false }));
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial-base"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: {
				reloadExtension,
				getRegisteredTool: () => undefined,
				getExtensionEntryMtimes: () => new Map(),
				hasHandlers: () => false,
				emit: async () => undefined,
			} as unknown as ExtensionRunner,
		});
		return { session: session!, agent };
	}

	it("parks the reload while streaming and defers to the next idle agent_end", async () => {
		const { session: s, agent } = createSession();

		// Busy: agent loop streaming.
		agent.state.isStreaming = true;
		const result = await s.reloadExtension(ENTRY_PATH);
		expect(result).toEqual({ removedTools: [], errors: [], deferred: true });
		expect(reloadExtension).not.toHaveBeenCalled();

		// Idle now; the parked reload performs on the next agent_end settle.
		agent.state.isStreaming = false;
		agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);
		await pollUntil(() => reloadExtension.mock.calls.length > 0);
		expect(reloadExtension).toHaveBeenCalledWith(ENTRY_PATH, expect.any(String));
	});

	it("reloads immediately when idle", async () => {
		const { session: s } = createSession();

		const result = await s.reloadExtension(ENTRY_PATH);
		expect(result).toEqual({ removedTools: [], errors: [], deferred: false });
		expect(reloadExtension).toHaveBeenCalledWith(ENTRY_PATH, expect.any(String));
	});

	it("returns an empty result without a runner", async () => {
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial-base"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: undefined,
		});

		expect(await session.reloadExtension(ENTRY_PATH)).toEqual({
			removedTools: [],
			errors: [],
			deferred: false,
		});
	});
});
