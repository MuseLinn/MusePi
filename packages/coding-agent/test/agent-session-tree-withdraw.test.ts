/**
 * Withdraw (撤回) of a user message that is itself the current leaf.
 *
 * The agent was stopped before any reply landed, so the user's message is the
 * leaf. Navigating back to it must move the active position to its parent and
 * hand its text to the composer — the withdrawn message has to leave the
 * active path. Returning the "already at target" no-op instead reported
 * success while the message stayed on screen (user report: the transcript
 * said 已回退, the text returned to the input, and the bubble was still there).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession withdraw of a leaf user message", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	const replyEmpty = false;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tree-withdraw-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mock = createMockModel({ handler: () => ({ content: replyEmpty ? [] : ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("moves the leaf to the parent and hands back the withdrawn text", async () => {
		// Seed the exact state the report showed: a user message is the active
		// leaf because the run was stopped before any reply landed.
		const manager = session.sessionManager;
		manager.appendMessage({
			role: "user",
			content: "first prompt",
			timestamp: Date.now(),
		});
		const reply = manager.appendMessage(createAssistantMessage("done"));
		const withdrawn = manager.appendMessage({
			role: "user",
			content: "second prompt",
			timestamp: Date.now(),
		});
		expect(manager.getLeafId()).toBe(withdrawn);

		const result = await session.navigateTree(withdrawn, {});

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("second prompt");
		// Landing position is the parent of the user message, so the withdrawn
		// bubble leaves the active path.
		expect(manager.getLeafId()).toBe(reply);
		expect(session.messages.some(message => message.role === "user" && message.content === "second prompt")).toBe(
			false,
		);
		expect(session.messages.some(message => message.role === "user" && message.content === "first prompt")).toBe(
			true,
		);
	});
});
