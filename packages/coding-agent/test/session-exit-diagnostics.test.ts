import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import { Agent, type AgentTool } from "@musepi/pi-agent-core";
import type { AssistantMessage } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AppendJournal } from "@musepi/pi-coding-agent/daemon/journal";
import { ExtensionToolWrapper } from "@musepi/pi-coding-agent/extensibility/extensions/wrapper";
import { LspTool } from "@musepi/pi-coding-agent/lsp/tool";
import { createSessionTeardown } from "@musepi/pi-coding-agent/modes/session-teardown";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import {
	collectPendingToolCalls,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "@musepi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { ReadTool } from "@musepi/pi-coding-agent/tools/read";
import { SecurityScanTool } from "@musepi/pi-coding-agent/tools/security-scan";
import { postmortem, TempDir } from "@musepi/pi-utils";

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "toolu_repro",
			name: "bash",
			arguments: { command: "bun run check:ts" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

describe("session exit diagnostics", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("records a durable tool start marker and shutdown diagnostic before a pending result exists", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		const marker = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE);
		if (marker?.type !== "custom") throw new Error("Expected tool execution start marker");
		expect(marker.data).toMatchObject({
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});

		const pending = collectPendingToolCalls(sessionManager.getBranch());
		expect(pending).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");

		await session.dispose();
		session = undefined;
		// dispose() released the in-memory transcript; the exit marker's contract
		// is durability, so assert against the persisted file.
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const exitEntry = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		await reopened.close();
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "dispose",
			kind: "normal",
			pendingToolCalls: [
				{
					toolCallId: "toolu_repro",
					toolName: "bash",
					args: { command: "bun run check:ts" },
				},
			],
		});
	});

	it("signal teardown persists the postmortem reason, not the generic dispose", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-signal-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const activeSession = session;

		// The assistant message persists through an async queue; the tool start
		// marker is appended synchronously and is what makes the session durable
		// enough for #recordSessionExit to write the exit entry (same setup as
		// the plain-dispose test above).
		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		// Mirror InteractiveMode.init(): the postmortem "session-teardown"
		// callback runs FIRST on SIGTERM/SIGHUP/uncaughtException (reverse
		// registration order) and calls dispose(). Without reason threading,
		// #doDispose would persist the generic "dispose"/"normal" and cancel the
		// reason-specific agent-session recorder — losing the real trigger.
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => activeSession.beginDispose(),
			saveDraft: async () => {},
			disposeSession: reason => activeSession.dispose({ reason }),
		});

		await teardown(postmortem.Reason.SIGTERM);
		session = undefined;

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const exitEntry = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		await reopened.close();
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "sigterm",
			kind: "signal",
		});
	});

	it("does not materialize an empty session just to write an exit marker", async () => {
		tempDir = TempDir.createSync("@pi-empty-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file path");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await session.dispose();
		session = undefined;

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(
			sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE),
		).toBe(false);
	});

	it("treats assistant tool calls as pending even when stopReason is not toolUse", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");
	});

	it("clears the pending warning once the matching tool result is recorded", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
			startedAt: new Date().toISOString(),
		} satisfies ToolExecutionStartData);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});

		expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs an abnormal process-exit tail as one terminal aborted assistant message", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "partial result stays in history" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const recovered = createInterruptedTurnAbortMessage(sessionManager.getBranch());
		expect(recovered).toMatchObject({
			role: "assistant",
			content: [],
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
		expect(recovered?.errorMessage).toContain("process exited");

		sessionManager.appendMessage(recovered!);
		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
		expect(
			sessionManager
				.buildSessionContext()
				.messages.some(
					message =>
						message.role === "toolResult" &&
						message.content.some(part => part.type === "text" && part.text === "partial result stays in history"),
				),
		).toBe(true);
	});

	it("reconstructs a normal exit that reports pending tool calls", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
			pendingToolCalls: [{ toolCallId: "toolu_repro", toolName: "bash" }],
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("ignores malformed pending tool diagnostics on normal exits", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
			pendingToolCalls: "not an array",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs an interrupted assistant tool-call tail", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			content: [],
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
	});

	it("reconstructs tool-call content even when stopReason is stop", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("does not reconstruct a failed tool turn already closed by synthetic results", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "error" });
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "Tool execution stopped after model failure." }],
			isError: true,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs a first user-message tail with selected model metadata", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(
			createInterruptedTurnAbortMessage(sessionManager.getBranch(), {
				api: pendingAssistant.api,
				provider: pendingAssistant.provider,
				model: pendingAssistant.model,
			}),
		).toMatchObject({
			role: "assistant",
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
	});

	it("does not reconstruct clean, completed, or superseded exits", () => {
		const normalExit = SessionManager.inMemory();
		normalExit.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		normalExit.appendMessage(pendingAssistant);
		normalExit.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const completedTurn = SessionManager.inMemory();
		completedTurn.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		completedTurn.appendMessage({
			...pendingAssistant,
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		});
		completedTurn.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const supersededExit = SessionManager.inMemory();
		supersededExit.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
		supersededExit.appendMessage(pendingAssistant);
		supersededExit.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		supersededExit.appendMessage({ role: "user", content: "new turn", timestamp: Date.now() });

		expect(createInterruptedTurnAbortMessage(normalExit.getBranch())).toBeUndefined();
		expect(createInterruptedTurnAbortMessage(completedTurn.getBranch())).toBeUndefined();
		expect(createInterruptedTurnAbortMessage(supersededExit.getBranch())).toBeUndefined();
	});

	describe("durable intent", () => {
		async function runScenario(
			options: {
				readOnly?: boolean;
				failFlush?: boolean;
				proxied?: boolean;
				args?: Record<string, unknown>;
				createTool?: (dir: string, order: string[]) => AgentTool | Promise<AgentTool>;
			} = {},
		) {
			tempDir = TempDir.createSync("@pi-durable-intent-");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model to exist");
			const order: string[] = [];
			const definition = options.createTool
				? await options.createTool(tempDir.path(), order)
				: {
						name: "probe",
						label: "Probe",
						description: "Probe durable intent",
						parameters: type({}),
						...(options.readOnly ? { requiresDurableIntent: false } : {}),
						execute: async () => {
							order.push("execute");
							return { content: [{ type: "text" as const, text: "done" }] };
						},
					};
			const tool = options.proxied
				? new ExtensionToolWrapper(definition, {
						consumeToolCallEmitted: () => true,
						hasHandlers: () => false,
					} as never)
				: definition;
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "call-1", name: tool.name, arguments: options.args ?? {} }] },
					{ content: ["done"] },
				],
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
				streamFn: (streamModel, context, streamOptions) => mock.stream(streamModel, context, streamOptions),
			});
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
			const journal = new AppendJournal(tempDir.path(), "s1");
			await journal.open();
			try {
				session = new AgentSession({
					agent,
					sessionManager,
					settings: Settings.isolated({ "compaction.enabled": false }),
					modelRegistry,
					flushDurableToolIntent: async event => {
						order.push("flush");
						journal.append(event as never);
						if (options.failFlush) throw new Error("flush failed");
						await journal.flush();
					},
				});
				session.subscribe(event => {
					if (event.type === "tool_execution_start") order.push("start");
				});
				await session.prompt("run the probe");
				await session.waitForIdle();
				const toolResult = agent.state.messages.find(message => message.role === "toolResult");
				return {
					order,
					startCount: order.filter(item => item === "start").length,
					entries: sessionManager.getEntries(),
					records: await journal.readAll(),
					toolResult,
				};
			} finally {
				await journal.close();
			}
		}

		it("flushes subscriber intent before a synchronous side effect and emits start once", async () => {
			const scenario = await runScenario();
			expect(scenario.order).toEqual(["start", "flush", "execute"]);
			expect(scenario.startCount).toBe(1);
			expect(scenario.records.map(record => record.event.type)).toEqual(["tool_execution_start"]);
			const assistantIndex = scenario.entries.findIndex(
				entry => entry.type === "message" && entry.message.role === "assistant",
			);
			const markerIndex = scenario.entries.findIndex(
				entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE,
			);
			expect(assistantIndex).toBeGreaterThanOrEqual(0);
			expect(markerIndex).toBeGreaterThan(assistantIndex);
		});

		it("lets an explicitly read-only tool skip the barrier", async () => {
			const scenario = await runScenario({ readOnly: true });
			expect(scenario.order).not.toContain("flush");
			expect(scenario.order).toContain("execute");
			expect(scenario.startCount).toBe(1);
			expect(scenario.records).toEqual([]);
		});

		it("skips the barrier for a proxied built-in read-only tool", async () => {
			const scenario = await runScenario({
				proxied: true,
				args: { path: "sample.txt" },
				createTool: async (dir, order) => {
					const tool = new ReadTool({
						cwd: dir,
						hasUI: false,
						getSessionFile: () => null,
						getSessionSpawns: () => "*",
						enableLsp: false,
						settings: Settings.isolated(),
						getArtifactsDir: () => null,
						getSessionId: () => null,
						getPlanModeState: () => undefined,
					} as never);
					await Bun.write(path.join(dir, "sample.txt"), "sample");
					const execute = tool.execute.bind(tool);
					tool.execute = async (_toolCallId, params, signal, onUpdate, context) => {
						order.push("execute");
						return execute(_toolCallId, params, signal, onUpdate, context);
					};
					return tool as AgentTool;
				},
			});
			expect(scenario.order).not.toContain("flush");
			expect(scenario.order).toContain("execute");
			expect(scenario.startCount).toBe(1);
			expect(scenario.records).toEqual([]);
		});

		for (const { name, args, create } of [
			{
				name: "an LSP file rename",
				args: { action: "rename_file", file: "old.ts", new_name: "new.ts" },
				create: () => new LspTool({} as never),
			},
			{
				name: "a cloud security scan",
				args: { action: "cloud_start" },
				create: () => new SecurityScanTool({} as never),
			},
		]) {
			it(`keeps the durable barrier for ${name}`, async () => {
				const scenario = await runScenario({
					args,
					createTool: (_dir, order) => {
						const tool = create() as AgentTool;
						tool.execute = async () => {
							order.push("execute");
							return { content: [{ type: "text", text: "done" }] };
						};
						return tool;
					},
				});
				expect(scenario.order).toEqual(["start", "flush", "execute"]);
			});
		}

		const lspScenario = (action: string) =>
			runScenario({
				proxied: true,
				args: { action },
				createTool: (_dir, order) => {
					const tool = new LspTool({} as never) as AgentTool;
					tool.execute = async () => {
						order.push("execute");
						return { content: [{ type: "text", text: "done" }] };
					};
					return tool;
				},
			});

		for (const action of ["hover", "status"]) {
			it(`lets read-only LSP action ${action} skip the barrier through its wrapper`, async () => {
				const scenario = await lspScenario(action);
				expect(scenario.order).not.toContain("flush");
				expect(scenario.order).toContain("execute");
				expect(scenario.startCount).toBe(1);
				expect(scenario.records).toEqual([]);
			});
		}

		it("keeps the durable barrier for raw LSP requests", async () => {
			const scenario = await lspScenario("request");
			expect(scenario.order).toEqual(["start", "flush", "execute"]);
		});

		it("fails closed when the durable flush rejects", async () => {
			const scenario = await runScenario({ failFlush: true });
			expect(scenario.order).not.toContain("execute");
			expect(scenario.toolResult).toMatchObject({ role: "toolResult", isError: true });
			expect(JSON.stringify(scenario.toolResult)).toContain("flush failed");
		});
	});
});
