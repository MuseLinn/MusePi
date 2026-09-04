import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@musepi/pi-agent-core";
import * as compactionModule from "@musepi/pi-agent-core/compaction";
import type { AssistantMessage, Model, UserMessage } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import type { CompactionMethod } from "@musepi/pi-coding-agent/session/compaction-methods";
import { SessionMaintenance, type SessionMaintenanceHost } from "@musepi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import * as snapcompactModule from "@musepi/snapcompact";

const CONTEXT_WINDOW = 100_000;
const THRESHOLD = 50_000;
const SPECULATION_BAND_START = THRESHOLD - 8_192;

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string, model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 10_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("async speculative compaction", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let sessionManager: SessionManager;
	let maintenance: SessionMaintenance;
	let events: string[];

	function appendSummarizableConversation(): void {
		const text = "conversation ".repeat(8_000);
		sessionManager.appendMessage(userMessage(text));
		sessionManager.appendMessage(assistantMessage("response ".repeat(8_000), model));
		sessionManager.appendMessage(userMessage(text));
		sessionManager.appendMessage(assistantMessage("final response", model));
	}

	let maintenanceSettings: Settings;

	function createMaintenance(
		options: { asyncEnabled?: boolean; methodOrder?: CompactionMethod[] } = {},
	): SessionMaintenance {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": options.asyncEnabled ?? true,
			"compaction.methodOrder": options.methodOrder ?? ["soft"],
			"compaction.thresholdPercent": 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
		});
		maintenanceSettings = settings;
		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: undefined,
			sideStreamFn: async () => {
				throw new Error("The compact seam should be used instead of the side stream");
			},
			providerSessionState: new Map(),
			preferWebsockets: undefined,
			model: () => model,
			thinkingLevel: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isGeneratingHandoff: () => false,
			promptGeneration: () => 0,
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			baseSystemPrompt: () => ["Test"],
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({}),
			memoryBackendSession: () => undefined,
			emitSessionEvent: async (event: { type: string }) => {
				events.push(event.type);
			},
			emitNotice: () => {},
			schedulePostPromptTask: () => {},
			scheduleAgentContinue: () => {},
			scheduleCompactionContinuation: () => false,
			persistTurnMessagesForMidRunCompaction: async () => false,
			findLastAssistantMessage: () => undefined,
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: () => ({ messages: [] }),
			convertToLlmForSideRequest: (messages: AgentMessage[]) => messages as never,
			obfuscateTextForProvider: (text: string | undefined) => text,
			obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
			closeCodexProviderSessionsForHistoryRewrite: () => {},
			resetCodexProviderAfterCompaction: () => {},
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			resetAdvisorRuntimes: () => {},
			clearAdvisorCost: () => {},
			rebaseAfterCompaction: () => {},
			recordAnchoredHistoryRewrite: () => {},
			getContextBreakdown: () => undefined,
			getContextUsage: () => undefined,
			shake: async () => ({ modified: false, tokensRemoved: 0 }),
			dropImages: async () => ({ removed: 0 }),
			generateHandoffDocument: async () => undefined,
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => ({ deferredHandoff: false, continuationScheduled: false }),
			parseRetryAfterMsFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
			abortHandoff: () => {},
		} as unknown as SessionMaintenanceHost;
		return new SessionMaintenance(host);
	}

	async function waitForState(state: "idle" | "running" | "armed"): Promise<void> {
		for (let microtask = 0; microtask < 100 && maintenance.speculationState !== state; microtask++) {
			await Promise.resolve();
		}
		if (maintenance.speculationState !== state) {
			throw new Error(`Speculation did not become ${state}`);
		}
	}

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in model");
		model = { ...bundled, contextWindow: CONTEXT_WINDOW };
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();
		events = [];
		appendSummarizableConversation();
		maintenance = createMaintenance();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	it("does not call the summarizer below the speculative band, then arms inside it", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "speculative summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START - 1, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
		await waitForState("armed");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("commits an armed summary at threshold without paying for another summarizer call", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "armed summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("armed summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(events).toEqual(expect.arrayContaining(["auto_compaction_start", "auto_compaction_end"]));
	});

	it("discards an armed summary after a reset boundary and re-summarizes the new branch", async () => {
		let invocation = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `summary ${++invocation}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		sessionManager.appendResetBoundary();
		appendSummarizableConversation();

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(compactSpy).toHaveBeenCalledTimes(2);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("summary 2");
	});

	it("does not start speculative work when async compaction is disabled", () => {
		maintenance = createMaintenance({ asyncEnabled: false });
		const compactSpy = vi.spyOn(compactionModule, "compact");

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);

		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("does not speculate when snapcompact leads the configured methods", () => {
		// Snapcompact is local and effectively instant — there is no
		// summarization latency to hide, so no background run may start.
		const compactSpy = vi.spyOn(compactionModule, "compact");
		maintenance = createMaintenance({ methodOrder: ["snapcompact", "soft"] });

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);

		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("discards an armed summary when the real pass resolves to snapcompact", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "armed summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const snapSpy = vi.spyOn(snapcompactModule, "compact").mockImplementation(async preparation => ({
			summary: "snapcompact archive",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		// Method order changed after arming: the real pass now runs the instant
		// local method, and the stale LLM summary must not override it.
		maintenanceSettings.override("compaction.methodOrder", ["snapcompact"]);

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(snapSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("snapcompact archive");
		// Exactly the speculation's summarizer call — the pass never re-summarized.
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("clears an armed speculation when manual compaction starts", async () => {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "manual summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");

		await maintenance.compact();

		expect(maintenance.speculationState).toBe("idle");
	});

	it("defers a threshold pass that jumped past the band, then commits the armed result for free", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "grace summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		// One large turn skipped the pre-threshold band entirely: deferral must
		// start the speculation itself and keep the pass non-blocking.
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1_000, CONTEXT_WINDOW)).toBe(true);
		expect(maintenance.speculationState).toBe("running");
		// While the run is in flight, later boundaries inside the band keep deferring.
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1_500, CONTEXT_WINDOW)).toBe(true);
		await waitForState("armed");

		// Armed: deferral ends so the real pass splices the result in immediately.
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 2_000, CONTEXT_WINDOW)).toBe(false);
		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 2_000,
		});

		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("grace summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("stops deferring at the grace cap so the blocking pass reclaims context", () => {
		const compactSpy = vi.spyOn(compactionModule, "compact");

		// Lead floor (8192) bounds the band for a 50K threshold: at the cap the
		// blocking pass must own the recovery again.
		const graceCap = THRESHOLD + 8_192;
		expect(maintenance.deferThresholdCompactionToSpeculation(graceCap, CONTEXT_WINDOW)).toBe(false);
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("never defers when async compaction is disabled or a local method leads", () => {
		maintenance = createMaintenance({ asyncEnabled: false });
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1, CONTEXT_WINDOW)).toBe(false);
		expect(maintenance.speculationState).toBe("idle");

		// Snapcompact is local and effectively instant — blocking on it is fine.
		maintenance = createMaintenance({ methodOrder: ["snapcompact", "soft"] });
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1, CONTEXT_WINDOW)).toBe(false);
		expect(maintenance.speculationState).toBe("idle");
	});
});
