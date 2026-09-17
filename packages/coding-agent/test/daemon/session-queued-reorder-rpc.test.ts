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
 * `session.queuedReorder` (GUI 排队面板拖拽排序, openchamber
 * messageQueueStore.reorderQueue parity). The panel rows are dragged into a
 * new order; the daemon must reflect that order in `getQueuedMessages()` so
 * the panel and the actual delivery queue never diverge.
 *
 * Contract: within one group, the dragged message lands right before the
 * target; same-group only (steering↔followUp is a timing change, not a
 * sort); unmatched texts and no-op moves are rejected with moved=false and
 * leave the queue untouched.
 */
describe("session.queuedReorder RPC", () => {
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
					return { content: ["working"], delayMs: 200 };
				},
				{ content: ["done-1"] },
				{ content: ["done-2"] },
				{ content: ["done-3"] },
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
	const reorder = (group: "steering" | "followUp", from: string, to: string): Promise<unknown> =>
		server.handle("session.queuedReorder", { sessionId: "s1", group, from, to }, conn);

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queued-reorder-rpc-");
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

	test("moves the dragged message before the target within steering", async () => {
		running = session.prompt("do the thing");
		await started.promise;
		await session.steer("first");
		await session.steer("second");
		await session.steer("third");
		expect(session.getQueuedMessages().steering).toEqual(["first", "second", "third"]);

		const res = (await reorder("steering", "third", "first")) as { moved: boolean };
		expect(res.moved).toBe(true);
		expect(session.getQueuedMessages().steering).toEqual(["third", "first", "second"]);
	});

	test("upward and downward moves both resolve against the full queue", async () => {
		running = session.prompt("do the thing");
		await started.promise;
		await session.steer("a");
		await session.steer("b");
		await session.steer("c");

		// Move the head down: "a" lands before "c".
		expect((await reorder("steering", "a", "c")) as { moved: boolean }).toEqual({ moved: true });
		expect(session.getQueuedMessages().steering).toEqual(["b", "a", "c"]);

		// Move it back up: "a" lands before "b".
		expect((await reorder("steering", "a", "b")) as { moved: boolean }).toEqual({ moved: true });
		expect(session.getQueuedMessages().steering).toEqual(["a", "b", "c"]);
	});

	test("reordered order is what gets delivered", async () => {
		running = session.prompt("do the thing");
		await started.promise;
		await session.steer("first");
		await session.steer("second");
		await session.steer("third");

		await reorder("steering", "third", "first");
		// Steering is consumed head-first at each injection boundary, so the
		// new order is the delivery order.
		await session.waitForIdle();
		const delivered = session.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content.map(part => (part.type === "text" ? part.text : "[image]")).join(""),
			);
		expect(delivered).toEqual(["do the thing", "third", "first", "second"]);
	});

	test("no-op and unmatched texts are rejected without mutating the queue", async () => {
		running = session.prompt("do the thing");
		await started.promise;
		await session.steer("first");
		await session.steer("second");

		// from === to: no-op.
		expect((await reorder("steering", "first", "first")) as { moved: boolean }).toEqual({ moved: false });
		// Unknown from.
		expect((await reorder("steering", "nope", "first")) as { moved: boolean }).toEqual({ moved: false });
		// Unknown target.
		expect((await reorder("steering", "first", "nope")) as { moved: boolean }).toEqual({ moved: false });
		expect(session.getQueuedMessages().steering).toEqual(["first", "second"]);
	});

	test("cross-group move is refused", async () => {
		running = session.prompt("do the thing");
		await started.promise;
		await session.steer("guide");
		await session.followUp("later");
		expect(session.getQueuedMessages()).toEqual({ steering: ["guide"], followUp: ["later"] });

		// "later" lives in followUp; a steering-keyed reorder must not find it.
		expect((await reorder("steering", "later", "guide")) as { moved: boolean }).toEqual({ moved: false });
		expect(session.getQueuedMessages()).toEqual({ steering: ["guide"], followUp: ["later"] });
	});
});
