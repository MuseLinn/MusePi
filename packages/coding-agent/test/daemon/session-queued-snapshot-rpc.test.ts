import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { TempDir } from "@musepi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

describe("session queued snapshot RPC", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let server: DaemonServer;
	const conn = { id: "test" } as unknown as DaemonConnection;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queued-snapshot-rpc-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [] } }),
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
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	test("returns stable row ids, attachment counts and the persisted pause state", async () => {
		await server.handle("session.queuedPause", { sessionId: "s1", paused: true }, conn);
		await session.followUp("same", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
		await session.followUp("same");

		const snapshot = (await server.handle("session.queued", { sessionId: "s1" }, conn)) as {
			count: number;
			paused: boolean;
			followUp: { id: string; text: string; imageCount: number }[];
		};
		expect(snapshot.paused).toBe(true);
		expect(snapshot.count).toBe(2);
		expect(snapshot.followUp.map(item => item.text)).toEqual(["same", "same"]);
		expect(snapshot.followUp.map(item => item.imageCount)).toEqual([1, 0]);
		expect(snapshot.followUp[0]?.id).not.toBe(snapshot.followUp[1]?.id);

		const popped = (await server.handle(
			"session.queuedPop",
			{ sessionId: "s1", group: "followUp", id: snapshot.followUp[1]!.id },
			conn,
		)) as { images: unknown[] | null };
		expect(popped.images).toBeNull();
		const remaining = (await server.handle("session.queued", { sessionId: "s1" }, conn)) as {
			followUp: { id: string }[];
		};
		expect(remaining.followUp.map(item => item.id)).toEqual([snapshot.followUp[0]!.id]);

		await server.handle("session.queuedPause", { sessionId: "s1", paused: false }, conn);
		expect(session.queuedMessagesPaused).toBe(false);
	});
});
