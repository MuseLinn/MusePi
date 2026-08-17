import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@musepi/pi-ai";
import * as AIError from "@musepi/pi-ai/error";
import { getBundledModel } from "@musepi/pi-catalog/models";
import type { Model, Usage } from "@musepi/pi-catalog/types";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@musepi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@musepi/pi-utils";
import { createProviderErrorMessage } from "../../ai/src/providers/error-message";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMessage(content: AssistantMessage["content"], model: Model): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage: "timeout",
		timestamp: Date.now(),
	};
}

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	options: {
		fallbackChains?: Record<string, string[]>;
		textOutputCommitted?: boolean;
	} = {},
): TurnRecoveryHost {
	const settings = Settings.isolated(options.fallbackChains ? { "retry.fallbackChains": options.fallbackChains } : {});
	return {
		agent: undefined as never,
		sessionManager: undefined as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		textOutputCommitted: () => options.textOutputCommitted !== false,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		sessionId: () => "test-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

describe("TurnRecovery replay-unsafe output classification", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-replay-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("rolls back a usage fallback cancelled during model reconciliation", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model");
		let activeModel = model;
		const fallbackApplied = Promise.withResolvers<void>();
		const releaseReconciliation = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const emittedEvents: string[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
		} as never;
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
			if (nextModel.provider === fallback.provider && nextModel.id === fallback.id) {
				fallbackApplied.resolve();
				await releaseReconciliation.promise;
			}
		};
		host.emitSessionEvent = async event => {
			emittedEvents.push(event.type);
		};
		const recovery = new TurnRecovery(host);
		const controller = new AbortController();
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key", signal: controller.signal },
		);

		await fallbackApplied.promise;
		controller.abort();
		releaseReconciliation.resolve();
		const committed = await applying;

		expect(committed).toBe(false);
		expect(activeModel).toBe(model);
		expect(modelChanges).toEqual([]);
		expect(emittedEvents).toEqual([]);
	});

	it("does not commit a fallback superseded during model reconciliation", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback race model");
		const selectedModel = { ...fallback, baseUrl: "https://user-selected-route.example" };
		let activeModel = model;
		const fallbackApplied = Promise.withResolvers<void>();
		const releaseReconciliation = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const emittedEvents: string[] = [];
		const thinkingChanges: unknown[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
		} as never;
		host.setThinkingLevel = level => thinkingChanges.push(level);
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
			if (nextModel.provider === fallback.provider && nextModel.id === fallback.id) {
				fallbackApplied.resolve();
				await releaseReconciliation.promise;
			}
		};
		host.emitSessionEvent = async event => {
			emittedEvents.push(event.type);
		};
		const recovery = new TurnRecovery(host);
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key" },
		);

		await fallbackApplied.promise;
		activeModel = selectedModel;
		releaseReconciliation.resolve();
		const committed = await applying;

		expect(committed).toBe(false);
		expect(activeModel).toBe(selectedModel);
		expect(modelChanges).toEqual([]);
		expect(thinkingChanges).toEqual([]);
		expect(emittedEvents).toEqual([]);
	});
	it("keeps a committed fallback when cancellation arrives during applied-event delivery", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model");
		let activeModel = model;
		const eventStarted = Promise.withResolvers<void>();
		const releaseEvent = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
		} as never;
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
		};
		host.emitSessionEvent = async event => {
			if (event.type !== "retry_fallback_applied") return;
			eventStarted.resolve();
			await releaseEvent.promise;
		};
		const recovery = new TurnRecovery(host);
		const controller = new AbortController();
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key", signal: controller.signal },
		);

		await eventStarted.promise;
		controller.abort();
		releaseEvent.resolve();
		const committed = await applying;

		expect(committed).toBe(true);
		expect(activeModel.provider).toBe(fallback.provider);
		expect(activeModel.id).toBe(fallback.id);
		expect(modelChanges).toEqual([`${fallback.provider}/${fallback.id}`]);
	});

	it("treats a failed turn with partial non-whitespace text as NOT retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Here is the first part of my answer" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("allows replay-safe hard fallback and excludes committed text with a configured chain", () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
		};
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		// Thinking-only output is replay-safe: nothing visible reached the user.
		const message = makeMessage([{ type: "thinking", thinking: "safe reasoning before failing" }], model);
		const visible = makeMessage([{ type: "text", text: "Already shown" }], model);
		expect(recovery.isHardErrorFallbackEligible(visible)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("retries partial text while its buffered output remains uncommitted", () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
		};
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, { fallbackChains, textOutputCommitted: false }),
		);
		const message = makeMessage([{ type: "text", text: "Buffered partial answer" }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("excludes a Fireworks Fast failed turn with partial visible text from Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k2.6-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		const message = makeMessage([{ type: "text", text: "partial visible output" }], fastModel);
		expect(recovery.isFireworksFastFallbackEligible(message)).toBe(false);
	});

	it("keeps a Fireworks Fast empty/whitespace failed turn eligible for Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k2.6-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([], fastModel))).toBe(true);
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([{ type: "text", text: "   \n" }], fastModel))).toBe(
			true,
		);
	});

	it("treats a thinking-only partial turn as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Let me reason about this step by step." }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a whitespace-only text partial as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("keeps the tool-call case replay-unsafe (no regression)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps side-effecting output replay-unsafe while text is uncommitted", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { textOutputCommitted: false }));
		const message = makeMessage(
			[
				{ type: "text", text: "Buffered partial answer" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps an empty-content error retriable (baseline)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a mix of thinking and text as replay-unsafe (text wins)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Reasoning before the visible answer." },
				{ type: "text", text: "The answer is 42." },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats thinking plus whitespace-only text as replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Long reasoning." },
				{ type: "text", text: "  " },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("does not retry malformed calls after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Already shown" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("retries malformed calls with replay-safe output", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Unshown reasoning" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats generated images as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats Anthropic server tools as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{
					type: "anthropicServerTool",
					block: { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "status" } },
				},
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps replay-safe classifier refusals retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const thinking = makeMessage([{ type: "thinking", thinking: "reasoning before refusal" }], model);
		thinking.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(thinking)).toBe(true);

		const whitespace = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		whitespace.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(whitespace)).toBe(true);

		const empty = makeMessage([], model);
		empty.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(empty)).toBe(true);
	});

	it("does not retry a classifier refusal after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Visible refusal output" }], model);
		message.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps pre-stream provider diagnostics replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = createProviderErrorMessage(model, new Error("fetch failed"));
		expect(recovery.isRetryableError(message)).toBe(true);
	});
});
