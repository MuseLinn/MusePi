import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@musepi/pi-agent-core";
import type { Model } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { buildModel } from "@musepi/pi-catalog/build";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

// Modes v2 (§6.2) session.setMode contract: busy gate (deferred to the next
// idle agent_end, single pending slot, last-wins), immediate switch when idle,
// and unavailable without a mode-capable factory. The sdk-level switcher body
// (extensions + composer + model + settings) is exercised by its own unit
// tests; this covers the AgentSession delegation + gating.

const MODE_ID = "design";

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

describe("AgentSession setMode busy gate (modes v2)", () => {
	let session: AgentSession | undefined;
	let modeSwitcher: ReturnType<typeof vi.fn>;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	function createSession(): { session: AgentSession; agent: Agent } {
		modeSwitcher = vi.fn(async () => ({ ok: true }));
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
			modeSwitcher,
		});
		return { session: session!, agent };
	}

	it("parks the switch while streaming and defers to the next idle agent_end", async () => {
		const { session: s, agent } = createSession();

		// Busy: agent loop streaming.
		agent.state.isStreaming = true;
		const result = await s.setMode(MODE_ID, { hot: true });
		expect(result).toEqual({ ok: true, deferred: true });
		expect(modeSwitcher).not.toHaveBeenCalled();

		// Idle now; the parked switch performs on the next agent_end settle.
		agent.state.isStreaming = false;
		agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);
		await pollUntil(() => modeSwitcher.mock.calls.length > 0);
		expect(modeSwitcher).toHaveBeenCalledWith(MODE_ID, { hot: true });
	});

	it("switches immediately when idle; null (clear) passes through", async () => {
		const { session: s } = createSession();

		const result = await s.setMode(MODE_ID, { hot: true });
		expect(result).toEqual({ ok: true });
		expect(modeSwitcher).toHaveBeenCalledWith(MODE_ID, { hot: true });

		const cleared = await s.setMode(null);
		expect(cleared).toEqual({ ok: true });
		expect(modeSwitcher).toHaveBeenLastCalledWith(null, { hot: undefined });
	});

	it("returns an error without a mode-capable factory", async () => {
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
		});

		expect(await session.setMode(MODE_ID)).toEqual({
			ok: false,
			error: "mode switching is unavailable for this session",
		});
	});

	it("propagates the switcher's error result", async () => {
		const { session: s } = createSession();
		modeSwitcher.mockResolvedValueOnce({ ok: false, error: 'mode "nope" not found' });

		const result = await s.setMode("nope");
		expect(result).toEqual({ ok: false, error: 'mode "nope" not found' });
	});
});
