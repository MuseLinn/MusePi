import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@musepi/pi-agent-core";
import * as compactionModule from "@musepi/pi-agent-core/compaction";
import type { AssistantMessage, Model, UserMessage } from "@musepi/pi-ai";
import * as AIError from "@musepi/pi-ai/error";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { type CompactionMethod, resolveSpeculationMethod } from "@musepi/pi-coding-agent/session/compaction-methods";
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
		options: {
			asyncEnabled?: boolean;
			methodOrder?: CompactionMethod[];
			remoteEndpoint?: string;
			thresholdPercent?: number;
			modelThresholds?: Record<string, number | string | null>;
			modelThresholdsEnabled?: boolean;
			experimentalContextManagement?: boolean;
			rolloverTools?: boolean;
			queueNotesReminder?: (prompt: string) => void;
			extensionRunner?: SessionMaintenanceHost["extensionRunner"];
			generateHandoffDocument?: SessionMaintenanceHost["generateHandoffDocument"];
		} = {},
	): SessionMaintenance {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": options.asyncEnabled ?? true,
			"compaction.methodOrder": options.methodOrder ?? ["soft"],
			"compaction.thresholdPercent": options.thresholdPercent ?? 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			...(options.remoteEndpoint === undefined ? {} : { "compaction.remoteEndpoint": options.remoteEndpoint }),
			...(options.modelThresholds === undefined ? {} : { "compaction.modelThresholds": options.modelThresholds }),
			...(options.modelThresholdsEnabled === undefined
				? {}
				: { "compaction.modelThresholdsEnabled": options.modelThresholdsEnabled }),
			...(options.experimentalContextManagement === undefined
				? {}
				: { "compaction.experimentalContextManagement": options.experimentalContextManagement }),
		});
		maintenanceSettings = settings;
		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: options.extensionRunner,
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
			generateHandoffDocument: options.generateHandoffDocument ?? (async () => undefined),
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => ({ deferredHandoff: false, continuationScheduled: false }),
			parseRetryAfterMsFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
			abortHandoff: () => {},
			hasExperimentalContextRolloverTools: () => options.rolloverTools ?? false,
			takeExperimentalContextRolloverRequest: () => false,
			queueExperimentalContextNotesReminder: (prompt: string) => options.queueNotesReminder?.(prompt),
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

	it("discards an armed summary when the branch outgrew it past the recovery band", async () => {
		let invocation = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `summary ${++invocation}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");

		// A jump past the threshold leaves a tail the armed summary never covered.
		// Splicing it would land above the recovery band, so the real pass must
		// summarize a fresher cut instead of reusing the stale result.
		sessionManager.appendMessage(userMessage("later context ".repeat(20_000)));

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 5_000,
		});

		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("summary 2");
		expect(compactSpy).toHaveBeenCalledTimes(2);
	});

	it("falls back without re-sending a native speculation that failed for good", async () => {
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(
				new compactionModule.NativeCompactionError(
					Object.assign(new Error("Anthropic compaction response carried no compaction block"), { status: 400 }),
				),
			);
		const snapSpy = vi.spyOn(snapcompactModule, "compact").mockImplementation(async preparation => ({
			summary: "snapcompact archive",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));
		maintenance = createMaintenance({
			methodOrder: ["remote", "snapcompact"],
			remoteEndpoint: "https://example.invalid/compact",
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await maintenance.speculationCompletion;
		expect(compactSpy).toHaveBeenCalledTimes(1);

		// Later boundaries neither re-send it nor hold the threshold pass for it.
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START + 500, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("idle");
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1_000, CONTEXT_WINDOW)).toBe(false);

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 1_000,
		});
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.method : undefined).toBe("snapcompact");
		expect(snapSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).toHaveBeenCalledTimes(1);

		// The committed compaction starts a new cycle with a fresh native attempt.
		appendSummarizableConversation();
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
		await maintenance.speculationCompletion;
		expect(compactSpy).toHaveBeenCalledTimes(2);
	});

	it("speculates the next configured method after a native speculation failed for good", async () => {
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValueOnce(
				new compactionModule.NativeCompactionError(
					Object.assign(new Error("Anthropic compaction response carried no compaction block"), { status: 400 }),
				),
			)
			.mockImplementation(async preparation => ({
				summary: "soft summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
		maintenance = createMaintenance({
			methodOrder: ["remote", "soft"],
			remoteEndpoint: "https://example.invalid/compact",
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await maintenance.speculationCompletion;
		expect(compactSpy).toHaveBeenCalledTimes(1);

		// The failed native method is skipped; soft still runs in the background
		// instead of on the blocking threshold pass.
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START + 500, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1_000, CONTEXT_WINDOW)).toBe(true);
		await waitForState("armed");

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 1_000,
		});
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.method : undefined).toBe("soft");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("soft summary");
	});

	it("keeps speculating natively after a failure a retry can clear", async () => {
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(
				new compactionModule.NativeCompactionError(
					new AIError.ProviderHttpError("compaction failed: overloaded", 529),
				),
			);
		maintenance = createMaintenance({
			methodOrder: ["remote"],
			remoteEndpoint: "https://example.invalid/compact",
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await maintenance.speculationCompletion;
		expect(compactSpy).toHaveBeenCalledTimes(1);

		// A transient provider failure is retriable, so the next boundary retries.
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START + 500, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
		await maintenance.speculationCompletion;
		expect(compactSpy).toHaveBeenCalledTimes(2);
	});

	it("gives a new session a fresh native speculation", async () => {
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(
				new compactionModule.NativeCompactionError(
					Object.assign(new Error("Anthropic compaction response carried no compaction block"), { status: 400 }),
				),
			);
		maintenance = createMaintenance({
			methodOrder: ["remote"],
			remoteEndpoint: "https://example.invalid/compact",
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await maintenance.speculationCompletion;
		expect(compactSpy).toHaveBeenCalledTimes(1);

		await sessionManager.newSession();
		appendSummarizableConversation();
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
		await maintenance.speculationCompletion;
		expect(compactSpy).toHaveBeenCalledTimes(2);
	});

	it("discards an armed summary when a pending prompt exhausts recovery headroom", async () => {
		let invocation = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `summary ${++invocation}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		sessionManager.appendMessage(userMessage("post-snapshot request"));

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 45_000,
			pendingContextTokens: 45_000,
		});

		expect(compactSpy).toHaveBeenCalledTimes(2);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("summary 2");
	});

	it("discards an armed handoff summary when post-snapshot branch growth prevents recovery headroom", async () => {
		let handoffInvocation = 0;
		const generateHandoffDocument = vi.fn(async () => ({
			document: `handoff plan ${++handoffInvocation}`,
		}));
		maintenance = createMaintenance({
			methodOrder: ["handoff"],
			generateHandoffDocument:
				generateHandoffDocument as unknown as SessionMaintenanceHost["generateHandoffDocument"],
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		expect(generateHandoffDocument).toHaveBeenCalledTimes(1);

		// A massive turn committed after the snapshot blows past the recovery band.
		sessionManager.appendMessage(assistantMessage("large-tail-token ".repeat(45_000), model));

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 40_000,
		});

		expect(generateHandoffDocument).toHaveBeenCalledTimes(2);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toContain("handoff plan 2");
	});

	it("retains and claims an armed handoff summary when post-snapshot growth fits comfortably", async () => {
		let handoffInvocation = 0;
		const generateHandoffDocument = vi.fn(async () => ({
			document: `handoff plan ${++handoffInvocation}`,
		}));
		maintenance = createMaintenance({
			methodOrder: ["handoff"],
			generateHandoffDocument:
				generateHandoffDocument as unknown as SessionMaintenanceHost["generateHandoffDocument"],
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		expect(generateHandoffDocument).toHaveBeenCalledTimes(1);

		// A modest assistant turn committed after the snapshot leaf.
		sessionManager.appendMessage(assistantMessage("brief acknowledgment", model));

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		// The armed handoff summary is claimed without paying for another generation.
		expect(generateHandoffDocument).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toContain("handoff plan 1");
	});

	it("discards an armed summary when a persisted custom message prevents recovery headroom", async () => {
		let invocation = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `summary ${++invocation}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");

		// Custom messages participate in the rebuilt model context, so a large one
		// must invalidate the stale projection just like an assistant turn.
		sessionManager.appendCustomMessageEntry(
			"skill-prompt",
			"large-custom-token ".repeat(45_000),
			true,
			undefined,
			"user",
		);

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 40_000,
		});

		expect(compactSpy).toHaveBeenCalledTimes(2);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("summary 2");
	});

	it("applies a per-model threshold base to the speculation band", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "model summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		// A 40K base at 50% compacts at 20K, so the band starts at 11,808 even
		// though the real window is 100K and the global threshold is 50K.
		maintenance = createMaintenance({
			modelThresholds: { [`${model.provider}/${model.id}`]: 40_000 },
		});

		maintenance.maybeStartSpeculativeCompaction(11_000, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();

		maintenance.maybeStartSpeculativeCompaction(11_808, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
		await waitForState("armed");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("ignores per-model thresholds when the override setting is disabled", () => {
		const compactSpy = vi.spyOn(compactionModule, "compact");
		maintenance = createMaintenance({
			modelThresholds: { [`${model.provider}/${model.id}`]: 40_000 },
			modelThresholdsEnabled: false,
		});

		maintenance.maybeStartSpeculativeCompaction(11_808, CONTEXT_WINDOW);

		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("queues the notebook reminder in the pre-threshold band instead of speculating", () => {
		const reminder = vi.fn();
		const compactSpy = vi.spyOn(compactionModule, "compact");
		maintenance = createMaintenance({
			experimentalContextManagement: true,
			rolloverTools: true,
			queueNotesReminder: reminder,
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);

		expect(reminder).toHaveBeenCalledTimes(1);
		expect(reminder.mock.calls[0]?.[0]).toContain("<context-window-reminder>");
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("commits a notes-backed rollover instead of an LLM summary", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact");
		maintenance = createMaintenance({ experimentalContextManagement: true, rolloverTools: true });

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 1_000,
		});

		expect(compactSpy).not.toHaveBeenCalled();
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toContain("<context-window-rollover>");
		expect(entry?.type === "compaction" ? (entry.details as { kind?: string } | undefined)?.kind : undefined).toBe(
			"experimental-context-rollover",
		);
	});

	it("falls back to summary compaction when the rollover tools are unavailable", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "soft summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance = createMaintenance({ experimentalContextManagement: true, rolloverTools: false });

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 1_000,
		});

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("soft summary");
	});

	it("lets session_before_compact replace the rollover boundary", async () => {
		const emit = vi.fn(
			async (event: { type?: string; preparation?: { firstKeptEntryId: string; tokensBefore: number } }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				return {
					compaction: {
						summary: "hook rollover",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: { from: "hook" },
					},
				};
			},
		);
		maintenance = createMaintenance({
			experimentalContextManagement: true,
			rolloverTools: true,
			extensionRunner: { hasHandlers: () => true, emit } as unknown as SessionMaintenanceHost["extensionRunner"],
		});

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 1_000,
		});

		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("hook rollover");
		expect(entry?.type === "compaction" ? entry.fromExtension : undefined).toBe(true);
		expect(entry?.type === "compaction" ? (entry.details as { kind?: string } | undefined)?.kind : undefined).toBe(
			"experimental-context-rollover",
		);
	});

	it("honours a cancelled session_before_compact rollover", async () => {
		const emit = vi.fn(async (event: { type?: string }) =>
			event.type === "session_before_compact" ? { cancel: true } : undefined,
		);
		maintenance = createMaintenance({
			experimentalContextManagement: true,
			rolloverTools: true,
			extensionRunner: { hasHandlers: () => true, emit } as unknown as SessionMaintenanceHost["extensionRunner"],
		});

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 1_000,
		});

		expect(sessionManager.getEntries().findLast(item => item.type === "compaction")).toBeUndefined();
		expect(events).toContain("auto_compaction_end");
	});
});

describe("resolveSpeculationMethod", () => {
	it("speculates past snapcompact when the model's wire strips image input", () => {
		const settings = Settings.isolated({ "compaction.methodOrder": ["snapcompact", "soft"] }).getGroup("compaction");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in model");
		const visionModel = { ...bundled, contextWindow: CONTEXT_WINDOW };
		// Declared vision: snapcompact leads and is local, so nothing is speculated.
		expect(resolveSpeculationMethod(visionModel, settings)).toBeUndefined();
		// Same declared input, but the Chat Completions wire drops images for
		// DeepSeek, so snapcompact cannot run and soft is speculated instead.
		const textOnlyWire = {
			...visionModel,
			provider: "deepseek",
			id: "deepseek-chat",
			api: "openai-completions",
			input: ["text", "image"],
		} as Model;
		expect(resolveSpeculationMethod(textOnlyWire, settings)).toBe("soft");
	});
});
