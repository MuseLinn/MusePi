import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { resetBundledPluginsLoaded } from "@musepi/pi-coding-agent/bundled-plugins/loader";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "@musepi/pi-coding-agent/daemon/server";
import { resetMagicKeywordRegistry } from "@musepi/pi-coding-agent/modes/magic-keyword-registry";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@musepi/pi-utils";
import type { DisplayContext } from "@musepi/pi-wire";

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
