import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import { Agent, type AgentTool } from "@musepi/pi-agent-core";
import * as compactionModule from "@musepi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@musepi/pi-ai/utils/event-stream";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { TempDir } from "@musepi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

/**
 * A manual `/compact` aborts the live turn before summarizing. Upstream
 * oh-my-pi #11873 fixed the resulting dead end: the interrupted turn was never
 * resumed, so a long tool loop stopped after compaction and the user had to
 * type "continue" to nudge it back to life.
 *
 * These tests pin the three branches of the fix:
 *   1. mid-turn compaction resumes the interrupted turn;
 *   2. an idle compaction must NOT fabricate a turn;
 *   3. `suppressContinuation` (plan-mode "Approve and compact") stays stopped.
 */
describe("manual compaction resumes the interrupted turn (omp #11873)", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-manual-compact-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-manual-compact-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	/**
	 * Build a session whose first provider turn emits a tool call, then hand the
	 * test a hook to start a manual compaction while that loop is still running.
	 */
	async function createHarness(): Promise<{
		session: AgentSession;
	}> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.autoContinue": true,
			// Keep the recent window tiny so a small seeded history still yields a
			// cut point (prepareCompaction otherwise reports "session too small").
			"compaction.keepRecentTokens": 1,
			"compaction.thresholdTokens": -1,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "tool output" }] }),
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockBashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, _context) => {
				const stream = new AssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "All done." }],
					api: "anthropic-messages" as const,
					provider: "anthropic" as const,
					model: "claude-sonnet-4-5",
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
			toolRegistry: new Map([[mockBashTool.name, mockBashTool]]),
		});
		cleanups.push(() => session.dispose());
		return { session };
	}

	function mockCompaction(summary: string) {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary,
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	it("resumes when the compaction interrupted a live turn", async () => {
		const { session } = await createHarness();
		// Seed history so compact() has something to summarize.
		await session.prompt("first");
		await session.agent.waitForIdle();
		await session.prompt("second");
		await session.agent.waitForIdle();
		mockCompaction("MID-TURN-COMPACTED");

		const observed: string[] = [];
		session.subscribe(event => {
			if (event.type === "agent_start") observed.push("agent_start");
		});

		// Simulate the mid-turn state the fix keys off of: the agent is streaming
		// when compact() is entered, so the turn it aborts must be resumed.
		Object.defineProperty(session.agent.state, "isStreaming", { value: true, configurable: true });
		await session.compact();
		Object.defineProperty(session.agent.state, "isStreaming", { value: false, configurable: true });
		// Let the scheduled post-prompt continuation task run.
		await session.waitForIdle();

		expect(session.isCompacting).toBe(false);
		expect(session.messages[0]?.role).toBe("compactionSummary");
		// The auto-continue nudge is the observable proof the turn resumed.
		expect(observed).toContain("agent_start");
	});

	it("does not fabricate a turn when the session was idle", async () => {
		const { session } = await createHarness();
		await session.prompt("first");
		await session.agent.waitForIdle();
		await session.prompt("second");
		await session.agent.waitForIdle();
		mockCompaction("IDLE-COMPACTED");

		const observed: string[] = [];
		session.subscribe(event => {
			if (event.type === "agent_start") observed.push("agent_start");
		});

		// Idle at entry — no continuation may be scheduled, and the session must
		// settle without a new provider turn.
		await session.compact();
		await session.waitForIdle();

		expect(session.isCompacting).toBe(false);
		expect(observed).toEqual([]);
		expect(session.messages[0]?.role).toBe("compactionSummary");
	});

	it("honours suppressContinuation (plan-mode approve-and-compact)", async () => {
		const { session } = await createHarness();
		await session.prompt("first");
		await session.agent.waitForIdle();
		await session.prompt("second");
		await session.agent.waitForIdle();
		mockCompaction("PLAN-COMPACTED");

		const observed: string[] = [];
		session.subscribe(event => {
			if (event.type === "agent_start") observed.push("agent_start");
		});

		// Even mid-turn, plan approval must leave the turn stopped.
		Object.defineProperty(session.agent.state, "isStreaming", { value: true, configurable: true });
		await session.compact(undefined, { suppressContinuation: true });
		Object.defineProperty(session.agent.state, "isStreaming", { value: false, configurable: true });
		await session.waitForIdle();

		expect(session.isCompacting).toBe(false);
		expect(observed).toEqual([]);
		expect(session.messages[0]?.role).toBe("compactionSummary");
	});
});
