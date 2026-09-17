import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { TempDir } from "@musepi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

/**
 * `session.queuedSend` (GUI 排队面板「立即发出」) delivery order. Regression: the
 * RPC popped the clicked entry and re-delivered it with `deliverAs: "steer"`,
 * which appends — but steering is one-at-a-time and the loop takes the queue
 * HEAD at each injection boundary, so the clicked message was delivered only
 * after every message queued behind it had taken its own boundary. The panel
 * row never left the queue and the button read as inert.
 *
 * Contract: the clicked message is handed to the agent at the NEXT injection
 * boundary, ahead of whatever was queued in front of it, from both groups.
 */
describe("session.queuedSend RPC", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let server: DaemonServer;
	let started: PromiseWithResolvers<void>;
	let running: Promise<boolean>;

	async function createSession(): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		started = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60 };
				},
				{ content: ["after first steer"] },
				{ content: ["after second steer"] },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const host = {
			cwd: () => tempDir.path(),
			get: () => ({ sessionId: "s1", agentSession: session }),
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		server = new DaemonServer(host);
	}

	const conn = { id: "test" } as unknown as DaemonConnection;
	const sendNow = (group: "steering" | "followUp", text: string): Promise<unknown> =>
		server.handle("session.queuedSend", { sessionId: "s1", group, text }, conn);
	/** User-authored transcript entries in order — the delivery order the agent saw. */
	const deliveredOrder = (): string[] =>
		session.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content.map(part => (part.type === "text" ? part.text : "[image]")).join(""),
			);

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queued-send-rpc-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		await createSession();
	});

	afterEach(async () => {
		await session.abort().catch(() => {});
		await session.waitForIdle().catch(() => {});
		await running?.catch(() => {});
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	test("steer send-now is delivered next, ahead of the messages queued behind it", async () => {
		running = session.prompt("do the thing");
		await started.promise;
		await session.steer("first");
		await session.steer("second");
		expect(session.getQueuedMessages().steering).toEqual(["first", "second"]);

		await sendNow("steering", "second");
		// Promoted to the head: the next injection boundary sends THIS one.
		expect(session.getQueuedMessages().steering).toEqual(["second", "first"]);

		await session.waitForIdle();
		expect(deliveredOrder()).toEqual(["do the thing", "second", "first"]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});

	test("followUp send-now leaves 本轮后 and is delivered ahead of the queued steer", async () => {
		running = session.prompt("do the thing");
		await started.promise;
		await session.steer("guide");
		await session.followUp("later");
		expect(session.getQueuedMessages()).toEqual({ steering: ["guide"], followUp: ["later"] });

		await sendNow("followUp", "later");
		expect(session.getQueuedMessages()).toEqual({ steering: ["later", "guide"], followUp: [] });

		await session.waitForIdle();
		expect(deliveredOrder()).toEqual(["do the thing", "later", "guide"]);
	});
});
