import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@musepi/pi-agent-core";
import * as compactionModule from "@musepi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ToolCall } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@musepi/pi-ai/utils/event-stream";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import {
	ExtensionRunner,
	loadExtensionFromFactory,
	loadExtensions,
} from "@musepi/pi-coding-agent/extensibility/extensions";
import { SecretObfuscator } from "@musepi/pi-coding-agent/secrets";
import { AgentSession, type AgentSessionEvent } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { EventBus } from "@musepi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@musepi/pi-utils";
import * as snapcompact from "@musepi/snapcompact";

const HANDOFF_SECRET = "HANDOFF_SECRET_TOKEN_12345";
const UNRENDERABLE_SNAPCOMPACT_TEXT = "\uE000\uE001\uE002\uE003\uE004\uE005\uE006\uE007\uE008\uE009";

describe("AgentSession handoff", () => {
	// Immutable across the whole file: the model registry's synchronous bundled-model
	// load dominates per-test setup (~100ms each), and the auth store + bundled model
	// never change. Build them once. Per-test mutable state (session, session file,
	// emitted events) is rebuilt in beforeEach.
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];
	let obfuscator: SecretObfuscator;

	/** Poll `predicate` until it holds (returns as soon as the state is reached) or the
	 *  deadline elapses. Replaces blind settle sleeps for tests with a positive signal. */
	async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) {
				throw new Error("Timed out waiting for condition");
			}
			await Bun.sleep(1);
		}
	}

	/** Drain post-turn maintenance deterministically for negative tests (those proving
	 *  maintenance did NOT run, where there is no positive signal to poll on). Post-turn
	 *  work is scheduled fire-and-forget: a single event-loop turn lets the handler run to
	 *  its decision and register any compaction pass as a tracked post-prompt task, then
	 *  `waitForIdle()` drains that task to completion. */
	async function drainMaintenance(): Promise<void> {
		await Bun.sleep(0);
		await session.waitForIdle();
	}

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-handoff-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-handoff-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		obfuscator = new SecretObfuscator([{ type: "plain", content: HANDOFF_SECRET }]);

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
			obfuscator,
		});

		session.subscribe(event => {
			events.push(event);
		});

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("commits a handoff document as an in-place compaction", async () => {
		const handoffText = "## Goal\nContinue from here";
		const previousSessionFile = session.sessionFile;
		const previousSessionId = session.sessionId;
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue(handoffText);

		const result = await session.handoff();
		await drainMaintenance();

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);
		expect(session.sessionFile).toBe(previousSessionFile);
		expect(session.sessionId).toBe(previousSessionId);
		const compaction = sessionManager.getBranch().at(-1);
		expect(compaction).toMatchObject({ type: "compaction" });
		if (compaction?.type !== "compaction") throw new Error("Expected handoff compaction entry");
		expect(compaction.summary).toContain(handoffText);
		expect(session.agent.state.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("runs handoff generation through the configured side stream function", async () => {
		const handoffText = "## Goal\nContinue via side stream";
		let sideStreamCalls = 0;
		let capturedSideSessionId: string | undefined;
		const sideStreamFn: StreamFn = (requestModel, _context, options) => {
			sideStreamCalls++;
			capturedSideSessionId = options?.sessionId;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: handoffText }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		await session.dispose();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		sessionManager = await SessionManager.open(sessionFile, tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
			obfuscator,
			sideStreamFn,
		});
		const preHandoffSessionId = session.sessionId;

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation(async (context, requestModel, options) => {
				expect(options.completeImpl).toBeDefined();
				const message = await options.completeImpl!(requestModel, context, options.streamOptions);
				return message.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n");
			});

		const result = await session.handoff();

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);
		expect(sideStreamCalls).toBe(1);
		expect(capturedSideSessionId).toStartWith(`${preHandoffSessionId}:side:`);
	});

	it("obfuscates custom instructions before generating a handoff", async () => {
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue(`## Goal\nKeep ${placeholder}`);

		const result = await session.handoff(`preserve ${HANDOFF_SECRET}`);

		const handoffCall = generateHandoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("Expected generateHandoffFromContext call");
		// Custom instructions are obfuscated, rendered into the handoff prompt, and
		// appended as the trailing context message — the raw secret never reaches
		// the provider.
		const trailing = handoffCall[0].messages.at(-1);
		const trailingText =
			typeof trailing?.content === "string"
				? trailing.content
				: (trailing?.content ?? []).map(block => (block.type === "text" ? block.text : "")).join("");
		expect(trailingText).toContain(`preserve ${placeholder}`);
		expect(trailingText).not.toContain(HANDOFF_SECRET);
		expect(result?.document).toContain(HANDOFF_SECRET);
		expect(result?.document).not.toContain(placeholder);
	});

	it("obfuscates the previous compaction summary but preserves opaque replay data", async () => {
		session.settings.set("compaction.methodOrder", ["soft"]);
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			previousSummary: `summary ${HANDOFF_SECRET}`,
			previousPreserveData: {
				openaiRemoteCompaction: {
					replacementHistory: [{ role: "user", content: `history ${HANDOFF_SECRET}` }],
				},
			},
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: compactionModule.DEFAULT_COMPACTION_SETTINGS,
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "new summary",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.compact();

		const call = compactSpy.mock.calls[0];
		if (!call) throw new Error("Expected compact call");
		expect(call[0].previousSummary).toBe(`summary ${placeholder}`);
		expect(call[0].previousSummary).not.toContain(HANDOFF_SECRET);
		// Opaque provider-replay state (encrypted_content / replacementHistory) must pass through
		// byte-identical — rewriting it would corrupt OpenAI remote-compaction replay.
		expect(call[0].previousPreserveData).toBe(fixedPreparation.previousPreserveData);
	});

	it("obfuscates migrated snapcompact archive text but preserves opaque replay data", async () => {
		session.settings.set("compaction.methodOrder", ["soft"]);
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const replaySlot = {
			replacementHistory: [{ role: "user", content: `history ${HANDOFF_SECRET}` }],
		};
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			previousPreserveData: {
				openaiRemoteCompaction: replaySlot,
				[snapcompact.PRESERVE_KEY]: {
					frames: [],
					totalChars: 32,
					truncatedChars: 0,
					text: `archived ${HANDOFF_SECRET}`,
					textHead: `head ${HANDOFF_SECRET}`,
				},
			},
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: compactionModule.DEFAULT_COMPACTION_SETTINGS,
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "new summary",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.compact();

		const call = compactSpy.mock.calls[0];
		if (!call) throw new Error("Expected compact call");
		const preserve = call[0].previousPreserveData;
		if (!preserve) throw new Error("Expected previousPreserveData");
		// The archive plaintext that compact() migrates into the summary prompt is
		// redacted, so the raw secret never reaches the provider.
		const archive = preserve[snapcompact.PRESERVE_KEY] as { text: string; textHead: string };
		expect(archive.text).toBe(`archived ${placeholder}`);
		expect(archive.textHead).toBe(`head ${placeholder}`);
		expect(JSON.stringify(archive)).not.toContain(HANDOFF_SECRET);
		// Opaque provider-replay state stays byte-identical (same reference) — only the
		// snapcompact slot's text is rewritten.
		expect(preserve.openaiRemoteCompaction).toBe(replaySlot);
	});

	it("does not call the LLM summarizer when manual snapcompact preflight fails", async () => {
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [
				{
					role: "user",
					content: [{ type: "text", text: UNRENDERABLE_SNAPCOMPACT_TEXT.repeat(100) }],
					timestamp: 1,
				},
			],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "snapcompact" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("429 quota exhausted"));

		await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow(
			"snapcompact cannot render this conversation locally",
		);

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("advances from auto snapcompact to soft compaction when local preflight rejects the transcript", async () => {
		session.settings.set("compaction.methodOrder", ["snapcompact", "soft"]);
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [
				{
					role: "user",
					content: [{ type: "text", text: UNRENDERABLE_SNAPCOMPACT_TEXT.repeat(100) }],
					timestamp: 1,
				},
			],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "snapcompact" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.runIdleCompaction();

		const endEvent = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "auto_compaction_end" }> =>
				event.type === "auto_compaction_end" && event.action === "context-full",
		);
		expect(compactSpy).toHaveBeenCalled();
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "idle", action: "snapcompact" });
		expect(endEvent).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
		});
		expect(endEvent?.errorMessage).toBeUndefined();
		const downgradeNotice = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "notice" }> =>
				event.type === "notice" &&
				event.source === "compaction" &&
				event.message.startsWith("snapcompact disabled: unsupported characters for selected snapcompact font"),
		);
		expect(downgradeNotice?.message).toContain("trying the next preferred compaction method.");
	});

	it("strips hook-supplied snapcompact data when persisting context-full compaction", async () => {
		const localTempDir = TempDir.createSync("@pi-context-full-preserve-data-");
		const localSessionManager = SessionManager.inMemory(localTempDir.path());
		const firstKeptEntryId = localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session.compacting"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session.compacting"
					? {
							preserveData: {
								otherState: "keep-me",
								[snapcompact.PRESERVE_KEY]: { frames: [], totalChars: 0, truncatedChars: 0 },
							},
						}
					: undefined,
			),
			clearManagedTimers: vi.fn(),
			stopServices: vi.fn(),
		} as unknown as ExtensionRunner;
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "context-full summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
			preserveData: { resultState: "keep-result" },
		});
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
			}),
			modelRegistry,
			extensionRunner,
		});

		try {
			await localSession.compact();
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({
				otherState: "keep-me",
				resultState: "keep-result",
			});
			expect(compactionEntry.preserveData).not.toHaveProperty(snapcompact.PRESERVE_KEY);
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
		}
	});

	it("strips hook-supplied snapcompact data when persisting auto context-full compaction", async () => {
		const localTempDir = TempDir.createSync("@pi-auto-context-full-preserve-data-");
		const localSessionManager = SessionManager.inMemory(localTempDir.path());
		const firstKeptEntryId = localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session.compacting"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session.compacting"
					? {
							preserveData: {
								otherState: "keep-me",
								[snapcompact.PRESERVE_KEY]: { frames: [], totalChars: 0, truncatedChars: 0 },
							},
						}
					: undefined,
			),
			clearManagedTimers: vi.fn(),
			stopServices: vi.fn(),
		} as unknown as ExtensionRunner;
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "auto context-full summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
			preserveData: { resultState: "keep-result" },
		});
		const promptCacheKey = "inherited-parent-cache";
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			promptCacheKey,
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
			}),
			modelRegistry,
			extensionRunner,
		});

		try {
			await localSession.runIdleCompaction();
			expect(compactSpy).toHaveBeenCalledTimes(1);
			expect(compactSpy.mock.calls[0]?.[5]?.promptCacheKey).toBe(promptCacheKey);
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({
				otherState: "keep-me",
				resultState: "keep-result",
			});
			expect(compactionEntry.preserveData).not.toHaveProperty(snapcompact.PRESERVE_KEY);
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
		}
	});

	it("runs context maintenance before sending an oversized pending prompt", async () => {
		session.settings.set("compaction.methodOrder", ["soft"]);
		session.settings.set("compaction.thresholdTokens", 50);
		session.settings.set("compaction.keepRecentTokens", 1);
		session.settings.set("contextPromotion.enabled", false);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		});

		await session.prompt("pending prompt ".repeat(120));
		await waitFor(
			() =>
				compactSpy.mock.calls.length === 1 &&
				events.some(event => event.type === "auto_compaction_end" && event.aborted === false),
		);

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		expect(events.some(event => event.type === "auto_compaction_end" && event.aborted === false)).toBe(true);
	});

	it("falls back after one auto-compaction timeout instead of retrying the same model", async () => {
		session.settings.set("compaction.methodOrder", ["soft"]);
		session.settings.set("compaction.thresholdTokens", 50);
		session.settings.set("compaction.keepRecentTokens", 1);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("retry.baseDelayMs", 1);

		let firstCandidateKey: string | undefined;
		let fallbackCandidateKey: string | undefined;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			const candidateKey = `${candidate.provider}/${candidate.id}`;
			firstCandidateKey ??= candidateKey;
			if (candidateKey === firstCandidateKey) {
				throw new Error("Summarization failed: The operation timed out.");
			}
			fallbackCandidateKey = candidateKey;
			return {
				summary: "fallback compacted",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		});

		await session.prompt("pending prompt ".repeat(120));
		await waitFor(
			() =>
				fallbackCandidateKey !== undefined &&
				events.some(event => event.type === "auto_compaction_end" && event.aborted === false),
		);

		expect(
			compactSpy.mock.calls.filter(call => `${call[1].provider}/${call[1].id}` === firstCandidateKey),
		).toHaveLength(1);
		expect(fallbackCandidateKey).toBeDefined();
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps pre-prompt context-full checks aligned with provider-anchored usage", async () => {
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [
				{
					content: ["ok"],
					stopReason: "stop",
					usage: {
						input: 1_005,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_025,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});
		const seedUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		};
		const seedAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "short reasoning",
					thinkingSignature: JSON.stringify({
						id: "rs_repro",
						type: "reasoning",
						content: [],
						encrypted_content: "blob ".repeat(30_000),
						summary: [],
					}),
				},
				{ type: "text", text: "done" },
			],
			api: mock.api,
			provider: "openai",
			model: mock.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["Test"],
				tools: [],
				messages: [seedUser, seedAssistant],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 8_000,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		expect(session.getContextUsage({ contextWindow: 10_000 })).toMatchObject({
			tokens: 1_000,
			contextWindow: 10_000,
			percent: 10,
		});

		await session.prompt("small pending prompt");

		expect(compactSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);
	});
	it("floors pre-prompt context-full checks by the stored conversation when provider usage is deflated", async () => {
		// Mirror of the provider-anchored test, but the large payload is real, on-wire-
		// compressible text (what a before_provider_request hook like Headroom shrinks),
		// NOT encrypted reasoning. The provider reports a deflated 1k prompt tokens, yet
		// the stored conversation is ~20k tokens — compaction MUST still fire.
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [{ content: ["ok"], stopReason: "stop" }],
		});
		const seedUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		};
		// ~20k tokens of plain text in a normal text block — counted by the floor.
		const bulkText = "alpha beta gamma delta epsilon ".repeat(3_000);
		const seedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: bulkText }],
			api: mock.api,
			provider: "openai",
			model: mock.id,
			stopReason: "stop",
			// Deflated: a before_provider_request compressor shrank the request, so the
			// provider only billed ~1k prompt tokens for a ~20k-token conversation.
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [seedUser, seedAssistant] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 8_000,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		// Display still shows the provider-anchored (deflated) usage — only the
		// compaction decision takes the local floor.
		expect(session.getContextUsage({ contextWindow: 10_000 })?.tokens).toBe(1_000);

		await session.prompt("small pending prompt");

		// The floor (~20k from the stored text) exceeds the 8k threshold, so the
		// deflated 1k provider count no longer suppresses compaction.
		expect(compactSpy).toHaveBeenCalled();
	});
	it("counts current non-message token growth in provider-anchored pre-prompt checks", async () => {
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const emitBeforeAgentStart = vi
			.spyOn(extensionRunner, "emitBeforeAgentStart")
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ systemPrompt: ["expanded system prompt ".repeat(30_000)] });
		vi.spyOn(extensionRunner, "emit").mockResolvedValue(undefined);

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [
				{
					content: ["seed response"],
					stopReason: "stop",
					usage: {
						input: 1_000,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_010,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 8_000,
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
			extensionRunner,
		});
		session.subscribe(event => {
			events.push(event);
		});

		await session.prompt("seed prompt");
		expect(mock.calls).toHaveLength(1);
		expect(session.getContextUsage({ contextWindow: 10_000 })).toMatchObject({
			tokens: 1_000,
			contextWindow: 10_000,
			percent: 10,
		});

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		});

		await session.prompt("small pending prompt");
		await waitFor(
			() =>
				compactSpy.mock.calls.length === 1 &&
				events.some(event => event.type === "auto_compaction_end" && event.aborted === false),
		);

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(2);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
	});

	it("does not double-count unchanged non-message tokens in provider-anchored pre-prompt checks", async () => {
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [
				{
					content: ["seed response"],
					stopReason: "stop",
					usage: {
						input: 8_500,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 8_510,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{ content: ["ok"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["expanded system prompt ".repeat(30_000)],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 9_500,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});

		await session.prompt("seed prompt");
		expect(mock.calls).toHaveLength(1);
		session.settings.set("compaction.enabled", true);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await session.prompt("small pending prompt");
		await drainMaintenance();

		expect(compactSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(mock.calls).toHaveLength(2);
	});
	it("does not run auto maintenance after final yield", async () => {
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const yieldCall: ToolCall = {
			type: "toolCall",
			id: "call_yield_done",
			name: "yield",
			arguments: { result: { data: { done: true } } },
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [yieldCall],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { done: true } },
			},
			isError: false,
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await drainMaintenance();

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("persists the handoff compaction in the current session", async () => {
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected current session file");

		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue(handoffText);

		const result = await session.handoff();
		const entries = sessionManager.getBranch();
		const compaction = entries.at(-1);

		expect(result?.document).toBe(handoffText);
		expect(session.sessionFile).toBe(sessionFile);
		expect(compaction).toMatchObject({ type: "compaction" });
		if (compaction?.type !== "compaction") throw new Error("Expected handoff compaction entry");
		expect(compaction.summary).toContain(handoffText);
		expect(session.agent.state.messages.some(message => message.role === "compactionSummary")).toBe(true);
		const persistedSessionText = await Bun.file(sessionFile).text();
		expect(persistedSessionText).toContain(JSON.stringify(handoffText));
	});

	it("does not run auto maintenance when strategy is off", async () => {
		session.settings.set("compaction.methodOrder", []);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff");
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await drainMaintenance();

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("restores default methods when enabling auto-compaction from an empty order", () => {
		session.settings.set("compaction.enabled", true);
		session.settings.set("compaction.methodOrder", []);

		expect(session.autoCompactionEnabled).toBe(false);
		session.setAutoCompactionEnabled(true);
		expect(session.settings.get("compaction.methodOrder")).toEqual([
			"remote",
			"snapcompact",
			"handoff",
			"shake",
			"soft",
		]);
		expect(session.autoCompactionEnabled).toBe(true);
	});

	it("falls back to context-full maintenance for overflow when strategy is handoff", async () => {
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		const handoffSpy = vi.spyOn(session, "handoff");
		// Overflow falls back to context-full compaction; mock the summarization
		// call so the test never issues a real provider request (the fake runtime
		// key would 401 at network speed, which is nondeterministic in CI).
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "overflow compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		const overflowAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "overflow" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "error",
			errorMessage: "maximum context length is 200000 tokens, however you requested 200001 tokens",
			usage: {
				input: 120_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: overflowAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowAssistant] });
		await waitFor(() => events.filter(event => event.type === "auto_compaction_end").length === 1);

		expect(handoffSpy).not.toHaveBeenCalled();
		const startEvents = events.filter(event => event.type === "auto_compaction_start");
		expect(startEvents).toHaveLength(1);
		expect(startEvents[0]).toMatchObject({ type: "auto_compaction_start", reason: "overflow" });
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("uses handoff strategy for threshold-triggered auto maintenance", async () => {
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("handoff document");

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(
			() =>
				generateHandoffSpy.mock.calls.length === 1 &&
				events.filter(event => event.type === "auto_compaction_end").length === 1,
		);

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", aborted: false, willRetry: false });
		expect(sessionManager.getBranch().at(-1)).toMatchObject({ type: "compaction", summary: "handoff document" });
	});

	it("completes threshold-triggered auto-handoff while the original prompt is still unwinding", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "text", text: "maintenance trigger" }],
					stopReason: "stop",
					usage: {
						input: 190_000,
						output: 1_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 191_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const agentEndWillContinue: Array<boolean | undefined> = [];
		const extensionsResult = await loadExtensions([], tempDir.path());
		const captureAgentEnd = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", event => {
					agentEndWillContinue.push(event.willContinue);
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionsResult.runtime,
			"capture-agent-end",
		);
		const extensionRunner = new ExtensionRunner(
			[captureAgentEnd],
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["handoff", "soft"],
				"compaction.thresholdPercent": 1,
				"contextPromotion.enabled": false,
			}),
			extensionRunner,
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue from here");
		await session.prompt("Trigger threshold handoff");

		expect(mock.calls).toHaveLength(1);
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(agentEndWillContinue).toEqual([undefined]);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", action: "handoff", aborted: false });
		expect(endEvents[0]).not.toMatchObject({ errorMessage: expect.any(String) });
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
	});

	it("does not start agent.continue when threshold-handoff defers and todos are incomplete", async () => {
		// Reproduces the user-reported race: at agent_end, threshold + handoff strategy
		// schedules a deferred handoff and returns. The handler used to fall through to
		// #checkTodoCompletion, which scheduled agent.continue() — both fired concurrently,
		// rendering as "Auto-handoff" loader + an assistant message still streaming.
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("todo.enabled", true);
		session.settings.set("todo.reminders", true);

		// Active todo phase with an incomplete task so #checkTodoCompletion would normally fire.
		session.setTodoPhases([{ name: "Phase 1", tasks: [{ content: "unfinished work", status: "pending" }] }]);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue");
		const continueSpy = vi.spyOn(session.agent, "continue");

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(() => generateHandoffSpy.mock.calls.length === 1);
		await session.waitForIdle();

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(sessionManager.getBranch().at(-1)).toMatchObject({ type: "compaction", summary: "## Goal\nContinue" });
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("dispose unblocks the post-prompt drain when a deferred handoff is mid-flight", async () => {
		// Reproduces /exit / Ctrl+C-double-tap hanging when a deferred handoff is awaiting
		// the LLM call: dispose() now aborts the handoff controller before draining post-prompt
		// tasks, so Promise.allSettled() in #cancelPostPromptTasks can resolve.
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const { promise: handoffPending, resolve: resolveHandoff } = Promise.withResolvers<string>();

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation(async (_context, _model, options) => {
				// Mirror the real generateHandoffFromContext contract: reject when the
				// caller aborts via the stream-options signal.
				const signal = options.streamOptions.signal;
				return await new Promise<string>((resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("Handoff cancelled")), { once: true });
					handoffPending.then(resolve, reject);
				});
			});

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		// Let the deferred handoff post-prompt task enter the generateHandoff await.
		await waitFor(() => session.isGeneratingHandoff);
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(session.isGeneratingHandoff).toBe(true);

		// dispose must NOT wait for the LLM call to resolve on its own — it must abort it.
		const disposed = withTimeout(
			session.dispose().then(() => "disposed" as const),
			2_000,
			"Timed out waiting for session disposal",
		);

		await expect(disposed).resolves.toBe("disposed");
		// Releasing after the fact must not leak into other tests.
		resolveHandoff("handoff");
	});

	it("advances to soft compaction when handoff returns no document", async () => {
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("");
		// The soft-compaction fallback after handoff returns no document would
		// otherwise run real context-full compaction against the fake runtime key
		// and race a live 401 against the 1s waitFor deadline (nondeterministic
		// in CI). Mirror the sibling tests' mock so maintenance resolves offline.
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "post-handoff compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(() =>
			events.some(event => event.type === "auto_compaction_end" && event.action === "context-full"),
		);

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(2);
		expect(endEvents[0]).toMatchObject({
			type: "auto_compaction_end",
			action: "handoff",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-handoff returned no document; trying the next preferred compaction method.",
		});
		expect(endEvents[1]).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: false,
			willRetry: false,
		});
	});

	it("resets to the base system prompt before generating a handoff", async () => {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const emitBeforeAgentStart = vi.spyOn(extensionRunner, "emitBeforeAgentStart").mockResolvedValueOnce({
			systemPrompt: ["Hook override"],
		});
		vi.spyOn(extensionRunner, "emit").mockResolvedValue(undefined);

		const mock = createMockModel({
			responses: [{ content: ["normal response"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 1 }),
			modelRegistry,
			extensionRunner,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		await session.prompt("hello from user");
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue from here");
		await session.handoff();

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expect(mock.calls.map(c => c.context.systemPrompt?.join("\n\n") ?? "")).toEqual(["Hook override"]);
		const handoffCall = generateHandoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("Expected generateHandoffFromContext call");
		expect(handoffCall[0].systemPrompt).toEqual(["Test"]);
	});

	it("forwards the agent's provider prompt-cache key to the handoff request", async () => {
		// Cache parity: the live loop routes on the agent's promptCacheKey
		// (providerPromptCacheKey), so handoff must reuse it rather than this.sessionId
		// — otherwise sessions built with a distinct key still cold-miss the cache.
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			promptCacheKey: "shared-cache-key",
			sessionId: "provider-session-id",
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 1 }),
			modelRegistry,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue");

		await session.handoff();

		const call = generateHandoffSpy.mock.calls[0];
		if (!call) throw new Error("Expected generateHandoffFromContext call");
		const streamOptions = call[2].streamOptions;
		expect(streamOptions.promptCacheKey).toBe("shared-cache-key");
		// Side-request lineage stays unique so append-only provider state never mixes.
		expect(streamOptions.sessionId).toContain(":side:");
		expect(streamOptions.sessionId).not.toBe("shared-cache-key");
	});

	it("saves auto-handoff document to disk when enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue(handoffText);

		const result = await session.handoff(undefined, { autoTriggered: true });
		expect(result?.savedPath).toBeDefined();
		if (!result?.savedPath) throw new Error("Expected handoff document path");
		expect(result.savedPath.endsWith(".md")).toBe(true);
		const savedText = await Bun.file(result.savedPath).text();
		expect(savedText).toContain(handoffText);
	});

	it("does not save manual handoff document when save setting is enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nManual handoff");

		const result = await session.handoff();
		expect(result?.savedPath).toBeUndefined();
	});

	it("does not start handoff prompt when provided signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoffFromContext");

		await expect(session.handoff(undefined, { signal: controller.signal })).rejects.toThrow("Handoff cancelled");
		expect(generateHandoffSpy).not.toHaveBeenCalled();
	});

	it("aborts handoff generation when provided signal is cancelled", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<string>();
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation((_context, _model, options) => {
				started.resolve();
				const signal = options.streamOptions.signal;
				const onAbort = () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					cancelled.reject(error);
				};
				if (signal?.aborted) {
					onAbort();
				} else {
					signal?.addEventListener("abort", onAbort, { once: true });
				}
				return cancelled.promise;
			});

		const handoffPromise = session.handoff(undefined, { signal: controller.signal });
		await started.promise;
		controller.abort();

		await expect(handoffPromise).rejects.toThrow("Handoff cancelled");
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(generateHandoffSpy.mock.calls[0]?.[2]?.streamOptions?.signal?.aborted).toBe(true);
	});

	it("surfaces the reason when the harness aborts an in-flight handoff", async () => {
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<string>();
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockImplementation((_context, _model, options) => {
			started.resolve();
			options.streamOptions.signal?.addEventListener("abort", () => cancelled.reject(new Error("request aborted")), {
				once: true,
			});
			return cancelled.promise;
		});

		const handoffPromise = session.handoff();
		await started.promise;
		await session.abort({ reason: "Harness stopped the session" });

		await expect(handoffPromise).rejects.toThrow("Harness stopped the session");
	});

	it("surfaces the real error when generation fails without a user abort", async () => {
		// Providers throw name==="AbortError" errors on non-user conditions (stalls,
		// nested resolution failures). The handoff signal is never aborted here, so the
		// failure must surface verbatim instead of being masked as "Handoff cancelled".
		const providerError = new Error("Deepseek stream stalled");
		providerError.name = "AbortError";
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockRejectedValue(providerError);

		await expect(session.handoff()).rejects.toThrow("Deepseek stream stalled");
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(session.isGeneratingHandoff).toBe(false);
	});

	it("surfaces empty handoff generation as a failure, not a false cancel", async () => {
		// Regression for #7993: the #7904 fix stopped masking provider errors as
		// "Handoff cancelled", but an empty/whitespace-only generation still returned
		// undefined, which the /handoff caller reported as "Handoff cancelled" with no
		// detail. Empty output is a real failure and must surface as one.
		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("   \n  ");

		await expect(session.handoff()).rejects.toThrow("Handoff generation produced no content");
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(session.isGeneratingHandoff).toBe(false);
	});

	it("auto-triggered handoff returns undefined on empty generation for context-full fallback", async () => {
		// Auto-handoff is best-effort: an empty document must NOT throw so maintenance
		// can fall back to context-full compaction (see runAutoCompaction).
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("");

		const result = await session.handoff(undefined, { autoTriggered: true });
		expect(result).toBeUndefined();
	});
});
