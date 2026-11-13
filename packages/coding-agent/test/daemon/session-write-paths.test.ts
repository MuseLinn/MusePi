import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { resetBundledPluginsLoaded } from "@musepi/pi-coding-agent/bundled-plugins/loader";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AppendJournal } from "@musepi/pi-coding-agent/daemon/journal";
import { type DaemonConnection, DaemonServer, DaemonSessionHost } from "@musepi/pi-coding-agent/daemon/server";
import { resetMagicKeywordRegistry } from "@musepi/pi-coding-agent/modes/magic-keyword-registry";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { WriteTool } from "@musepi/pi-coding-agent/tools/write";
import { removeSyncWithRetries, Snowflake } from "@musepi/pi-utils";
import type { DisplayContext } from "@musepi/pi-wire";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const quote: DisplayContext = { kind: "chat-quote", messageId: "assistant-1", quote: "quoted", comment: "note" };
const annotation: DisplayContext = {
	kind: "browser-annotation",
	pageUrl: "https://example.com",
	prompt: "Browser annotation:\nPage: Example",
	comment: "look",
};

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	resetBundledPluginsLoaded();
	resetMagicKeywordRegistry();
});

async function createSession(responses: MockResponse[]): Promise<Harness> {
	const tempDir = path.join(os.tmpdir(), `pi-display-context-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const mock = createMockModel({ responses });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	});
	const sessionManager = SessionManager.inMemory();
	const settings = Settings.isolated({ "compaction.enabled": false });
	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});
	return { session, sessionManager, mock };
}

describe("AgentSession displayContext write paths", () => {
	it("keeps model text and displayContext together on immediate send and persistence", async () => {
		const { session, sessionManager, mock } = await createSession([{ content: ["answer"] }]);
		await session.sendUserMessage("exact model text", { displayContext: quote });
		await session.waitForIdle();
		const user = session.agent.state.messages.find(message => message.role === "user");
		expect(user?.role).toBe("user");
		if (user?.role !== "user") throw new Error("missing user message");
		expect(user.content).toEqual([{ type: "text", text: "exact model text" }]);
		expect(user.displayContext).toEqual(quote);
		const persisted = sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		expect(persisted?.type).toBe("message");
		if (persisted?.type !== "message" || persisted.message.role !== "user") throw new Error("missing persisted user");
		expect(persisted.message.displayContext).toEqual(quote);
		expect(mock.calls).toHaveLength(1);
	});

	it("preserves both variants through working steer and followUp delivery", async () => {
		const { session } = await createSession([
			{ content: ["first"] },
			{ content: ["second"] },
			{ content: ["third"] },
		]);
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await session.sendUserMessage("steer text", { deliverAs: "steer", displayContext: quote });
			await session.sendUserMessage("follow text", { deliverAs: "followUp", displayContext: annotation });
		});
		await session.prompt("start");
		await session.waitForIdle();
		const users = session.agent.state.messages.filter(message => message.role === "user");
		const steer = users.find(
			message =>
				message.role === "user" &&
				typeof message.content !== "string" &&
				message.content[0]?.type === "text" &&
				message.content[0].text === "steer text",
		);
		const follow = users.find(
			message =>
				message.role === "user" &&
				typeof message.content !== "string" &&
				message.content[0]?.type === "text" &&
				message.content[0].text === "follow text",
		);
		expect(steer?.role === "user" && steer.displayContext).toEqual(quote);
		expect(follow?.role === "user" && follow.displayContext).toEqual(annotation);
	});

	it("returns context on queuedPop and retains it on queuedSend", async () => {
		const { session } = await createSession([]);
		// Manual queue operations must not race the idle auto-drain they do not own.
		session.setQueuedMessagesPaused(true);
		await session.sendUserMessage("queued text", { deliverAs: "followUp", displayContext: quote });
		const restored = session.popQueuedMessage("followUp", "queued text");
		expect(restored).toEqual({ text: "queued text", images: undefined, displayContext: quote });
		await session.sendUserMessage(restored!.text, {
			deliverAs: "followUp",
			displayContext: restored!.displayContext,
		});
		expect(await session.sendQueuedMessage("followUp", "queued text")).toBe(true);
		const queued = session.agent.peekSteeringQueue()[0];
		expect(queued?.role).toBe("user");
		if (queued?.role !== "user") throw new Error("missing re-queued user message");
		expect(queued.displayContext).toEqual(quote);
	});
});

describe("daemon session.send displayContext forwarding", () => {
	it("forwards immediate, steer, and followUp options without altering the text", async () => {
		const calls: Array<{ content: unknown; options: unknown }> = [];
		const live = {
			autoTitle: false,
			agentSession: {
				sendUserMessage: async (content: unknown, options: unknown) => {
					calls.push({ content, options });
				},
			},
		};
		const host = {
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
			cwd: () => "/tmp",
			get: () => live,
			subscribe: async () => {},
			touch: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const conn = {
			id: "display-context-test",
			writableLength: () => 0,
			send: () => {},
		} as unknown as DaemonConnection;
		for (const deliverAs of [undefined, "steer", "followUp"] as const) {
			await server.handle(
				"session.send",
				{ sessionId: "s1", text: "same text", deliverAs, displayContext: annotation },
				conn,
			);
		}
		expect(calls.map(call => call.content)).toEqual(["same text", "same text", "same text"]);
		expect(calls.map(call => call.options)).toEqual([
			{ displayContext: annotation },
			{ deliverAs: "steer", displayContext: annotation },
			{ deliverAs: "followUp", displayContext: annotation },
		]);
	});
});

describe("daemon durable intent", () => {
	it("flushes the adopted live journal before execute on create and reactivate", async () => {
		const chunks = [
			{ tool: "call-1", finish: "tool_calls" },
			{ finish: "tool_calls" },
			{ text: "first done", finish: "stop" },
			{ tool: "call-2", finish: "tool_calls" },
			{ finish: "tool_calls" },
			{ text: "second done", finish: "stop" },
		].map((part, index) => ({
			id: `chatcmpl-${index}`,
			object: "chat.completion.chunk",
			created: 0,
			model: "agnes-3.0-flash",
			choices: [
				{
					index: 0,
					delta: part.tool
						? {
								tool_calls: [
									{
										index: 0,
										id: part.tool,
										type: "function",
										function: { name: "write", arguments: JSON.stringify({ path: "out.txt", content: "x" }) },
									},
								],
							}
						: part.text
							? { content: part.text }
							: {},
					finish_reason: part.tool ? null : part.finish,
				},
			],
		}));
		let request = 0;
		const fetchMock = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const body = typeof init?.body === "string" ? init.body : "";
				const chunk = body.includes('"write"') ? chunks[request++] : chunks[2];
				if (!chunk) throw new Error("unexpected model request");
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
			{ preconnect: () => {} },
		);
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const order: string[] = [];
		const originalExecute = WriteTool.prototype.execute;
		const executeSpy = spyOn(WriteTool.prototype, "execute").mockImplementation(async function (
			this: WriteTool,
			...args: Parameters<WriteTool["execute"]>
		) {
			order.push("execute");
			return originalExecute.apply(this, args);
		});
		const host = new DaemonSessionHost();
		const originalFlush = AppendJournal.prototype.flush;
		const flushSpy = spyOn(AppendJournal.prototype, "flush").mockImplementation(async function (this: AppendJournal) {
			order.push("flush");
			return originalFlush.call(this);
		});
		const dir = await isolateAgentDirForTest("daemon-durable-intent-");
		cleanups.push(async () => {
			await host.dispose();
			flushSpy.mockRestore();
			executeSpy.mockRestore();
			fetchSpy.mockRestore();
			await restoreAgentDirForTest(dir);
		});

		await Bun.write(
			path.join(dir, "models.yml"),
			`providers:\n  mock:\n    baseUrl: http://127.0.0.1\n    apiKey: test-key\n    api: openai-completions\n    models:\n      - id: mock-model\n        name: Mock Model\n        reasoning: false\n        input: [text]\n        supportsTools: true\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 128000\n        maxTokens: 4096\n`,
		);
		const { sessionId } = await host.createSession({
			cwd: dir,
			modelPattern: "mock/mock-model",
		});
		const live = host.get(sessionId);
		if (!live) throw new Error("expected a live session");
		live.autoTitle = false;
		order.length = 0;
		await live.agentSession.prompt("first");
		await live.agentSession.waitForIdle();
		expect(order).toEqual(["flush", "execute"]);

		await live.dispose();
		const resumed = await host.activate(sessionId);
		resumed.autoTitle = false;
		order.length = 0;
		await resumed.agentSession.prompt("second");
		await resumed.agentSession.waitForIdle();
		expect(order).toEqual(["flush", "execute"]);
		const starts = (await resumed.journal!.readAll()).flatMap(record =>
			record.event.type === "tool_execution_start" ? [record.event.toolCallId] : [],
		);
		expect(starts).toEqual(["call-1", "call-2"]);
	});
});
