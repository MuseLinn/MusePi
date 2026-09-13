import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";

/**
 * Regression: a steer can land on an idle session — the submit path checks
 * `isStreaming` before `#queueSteer`'s (potentially slow) image normalization,
 * so the turn may end in between. Unlike `#queueFollowUp`, `#queueSteer` had no
 * idle drain: the message stranded in the queue (visible chip, never delivered)
 * until the next manual prompt.
 *
 * Contract: steering an idle session schedules an immediate `agent.continue()`,
 * so a queued steer is delivered without waiting for the next manual prompt. A
 * queued steer resumes from any tail (continue() injects it before the next
 * provider call), so there is no "non-resumable steer" case. While a turn is
 * still streaming the drain stands down and the steer simply stays queued.
 */

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function createToolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "Interrupted" }],
		isError: true,
		timestamp: Date.now(),
	};
}

describe("AgentSession steer idle drain", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;

	async function createSession(messages: Parameters<typeof Agent.prototype.appendMessage>[0][]): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({}),
			modelRegistry: new ModelRegistry(authStorage),
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-steer-idle-drain-");
		vi.useFakeTimers();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("delivers a steer queued on an idle resumable session via continue()", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("steer me please");

		// Drained without waiting for the next manual prompt.
		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("delivers a steer queued after an interrupted tool result", async () => {
		await createSession([
			{ role: "user", content: "hello", timestamp: Date.now() },
			createAssistantMessage(),
			createToolResultMessage(),
		]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("deliver after interrupt");

		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("sendQueuedMessage promotes the popped steer to the queue head", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		// Queue directly on the agent core (no idle-drain side effects); the
		// steer path's timers would hang under the suite's fake clock.
		session.agent.steer({ role: "user", content: "first", timestamp: 1 });
		session.agent.steer({ role: "user", content: "second", timestamp: 2 });
		expect(session.getQueuedMessages().steering).toEqual(["first", "second"]);

		// The idle drain 立即发出 schedules runs as a 0-delay post-prompt task —
		// the suite's fake clock cannot hold it back — and would call the real
		// agent.continue(), starting a real provider stream on this streamFn-less
		// Agent. Mock it like the drain tests above; what is asserted here is
		// queue ORDER, not delivery.
		// 立即发出 on this idle session arms the queue drain: a 0-delay post-prompt
		// task (immune to the suite's fake clock) that calls the REAL
		// agent.continue() — a provider stream on this streamFn-less Agent.
		// Capture what the next injection boundary delivers instead, and clear the
		// queues inside the mock: a no-op continue leaves them non-empty and the
		// drain re-arms forever.
		const deliveredAt: Array<readonly string[]> = [];
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			deliveredAt.push(session.getQueuedMessages().steering);
			session.agent.clearAllQueues();
		});

		const sent = await session.sendQueuedMessage("steering", "second");
		expect(sent).toBe(true);
		await session.waitForIdle();
		// 立即发出 = skip ahead: the popped message rides the NEXT injection
		// boundary, ahead of the message queued in front of it — appending behind
		// would deliver it only after that message took its own boundary.
		expect(deliveredAt[0]).toEqual(["second", "first"]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});

	it("sendQueuedMessage promotes a followUp to the steer head and rejects unknown text", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		session.agent.steer({ role: "user", content: "guide", timestamp: 1 });
		session.agent.followUp({ role: "user", content: "later", timestamp: 2 });
		expect(session.getQueuedMessages()).toEqual({ steering: ["guide"], followUp: ["later"] });

		// Same real-continue drain hazard as the steer test above: capture at the
		// injection boundary and clear inside the mock.
		const deliveredAt: { steering: readonly string[]; followUp: readonly string[] }[] = [];
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			deliveredAt.push(session.getQueuedMessages());
			session.agent.clearAllQueues();
		});

		const sent = await session.sendQueuedMessage("followUp", "later");
		expect(sent).toBe(true);
		await session.waitForIdle();
		// Leaves 本轮后 and becomes the NEXT steer — ahead of the steer queued
		// before it (send now = skip ahead, not queue behind).
		expect(deliveredAt[0]).toEqual({ steering: ["later", "guide"], followUp: [] });

		// Unknown text: no match, nothing sent, nothing re-queued.
		expect(await session.sendQueuedMessage("steering", "not queued")).toBe(false);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});

	it("popQueuedMessage removes one specific queued message without re-injecting", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		session.agent.steer({ role: "user", content: "first", timestamp: 1 });
		session.agent.steer({ role: "user", content: "second", timestamp: 2 });
		session.agent.followUp({ role: "user", content: "later", timestamp: 3 });

		// Per-item 取回 (GUI queue panel): pop by group+text, editor restore shape.
		const popped = session.popQueuedMessage("steering", "first");
		expect(popped?.text).toBe("first");
		expect(session.getQueuedMessages().steering).toEqual(["second"]);
		// Sibling group untouched; unlike sendQueuedMessage there is no re-inject.
		expect(session.getQueuedMessages().followUp).toEqual(["later"]);

		// Unknown text or wrong-group text: no match, queues untouched.
		expect(session.popQueuedMessage("followUp", "not queued")).toBeUndefined();
		expect(session.popQueuedMessage("steering", "later")).toBeUndefined();
		expect(session.getQueuedMessages().steering).toEqual(["second"]);
		expect(session.getQueuedMessages().followUp).toEqual(["later"]);
	});

	it("round-trips queued images through clearQueue for editor restoration", async () => {
		// A steer queued mid-stream stays in the queue (the idle drain stands down while
		// streaming), so clearQueue round-trips session.steer's normalized image payload
		// for editor restoration. A parked model turn gives a deterministic streaming
		// state. Real timers here: the prompt/stream path awaits real timers that the
		// suite's fake clock would gate (it hangs otherwise), and the parked turn is
		// cancelled by abort via the AbortSignal — never waited on — so there is no 60s wait.
		vi.useRealTimers();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const running = session.prompt("do the thing");
		await started.promise;
		expect(session.isStreaming).toBe(true);

		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		await session.steer("with image", [image]);

		const { steering } = session.clearQueue();
		expect(steering).toEqual([{ text: "with image", images: [image] }]);
		expect(session.agent.hasQueuedMessages()).toBe(false);

		await session.abort();
		await session.waitForIdle();
		await running.catch(() => {});
	});
});
