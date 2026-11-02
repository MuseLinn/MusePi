import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { TempDir } from "@musepi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("AgentSession persisted message queue", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	async function createSession(sessionFile?: string): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({ responses: [{ content: ["queued response"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile, tempDir.path())
			: SessionManager.create(tempDir.path(), tempDir.path());
		return new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queue-persistence-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("restores paused messages, attachments, display context and stable ids after reopening", async () => {
		session = await createSession();
		session.setQueuedMessagesPaused(true);
		await session.followUp("keep me", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], {
			displayContext: { kind: "chat-quote", quote: "quoted source" },
		});
		const before = session.getQueuedMessageSnapshot();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected a session file");
		await sessionManagerFlushAndDispose(session);
		session = undefined;

		session = await createSession(sessionFile);
		const after = session.getQueuedMessageSnapshot();
		expect(after.paused).toBe(true);
		expect(after.followUp).toHaveLength(1);
		expect(after.followUp[0]).toMatchObject({ id: before.followUp[0]?.id, text: "keep me", imageCount: 1 });
		const restored = session.popQueuedMessage("followUp", after.followUp[0]!.id);
		expect(restored?.images).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
		expect(restored?.displayContext).toEqual({ kind: "chat-quote", quote: "quoted source" });
	});

	it("operates on duplicate text by stable id", async () => {
		session = await createSession();
		session.setQueuedMessagesPaused(true);
		await session.followUp("same");
		await session.followUp("same");
		const queued = session.getQueuedMessageSnapshot().followUp;
		expect(queued).toHaveLength(2);
		expect(queued[0]?.id).not.toBe(queued[1]?.id);

		expect(session.popQueuedMessage("followUp", queued[1]!.id)?.text).toBe("same");
		expect(session.getQueuedMessageSnapshot().followUp.map(item => item.id)).toEqual([queued[0]!.id]);
	});

	it("does not restore a message that was consumed before reopening", async () => {
		session = await createSession();
		session.setQueuedMessagesPaused(true);
		await session.followUp("consume me");
		const id = session.getQueuedMessageSnapshot().followUp[0]!.id;
		expect(session.popQueuedMessage("followUp", id)).toBeDefined();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected a session file");
		await sessionManagerFlushAndDispose(session);
		session = undefined;

		session = await createSession(sessionFile);
		expect(session.getQueuedMessageSnapshot().followUp).toEqual([]);
	});

	it("keeps an idle restored queue paused until the user resumes it", async () => {
		session = await createSession();
		session.setQueuedMessagesPaused(true);
		await session.followUp("after restart");
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected a session file");
		await sessionManagerFlushAndDispose(session);
		session = undefined;

		session = await createSession(sessionFile);
		await Bun.sleep(40);
		expect(session.isStreaming).toBe(false);
		expect(session.getQueuedMessageSnapshot().followUp.map(item => item.text)).toEqual(["after restart"]);

		session.setQueuedMessagesPaused(false);
		await session.waitForIdle();
		expect(session.getQueuedMessageSnapshot().followUp).toEqual([]);
		expect(
			session.messages.some(
				message =>
					message.role === "user" &&
					typeof message.content !== "string" &&
					message.content[0]?.type === "text" &&
					message.content[0].text === "after restart",
			),
		).toBe(true);
	});
});

async function sessionManagerFlushAndDispose(session: AgentSession): Promise<void> {
	await session.sessionManager.flush();
	await session.dispose();
}
