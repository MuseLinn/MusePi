import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@musepi/pi-agent-core";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import type { CustomMessage, CustomMessageContent } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";

/**
 * Regression: entering plan/goal/vibe mode while streaming steers the mode
 * context into the running turn, and that steer is persisted. The next prompt
 * used to inject a second copy of the same customType/context because prompt
 * assembly rebuilt it unconditionally. The model then saw duplicate, sometimes
 * contradictory, mode instructions.
 *
 * Contract: prompt assembly skips a mode context whose latest delivered copy
 * has identical content. A real content change still delivers the newest
 * context exactly once, so revisions never stack identical duplicates.
 */

type ModeKind = "plan" | "goal" | "vibe";

const MODE_CUSTOM_TYPE: Record<ModeKind, string> = {
	plan: "plan-mode-context",
	goal: "goal-mode-context",
	vibe: "vibe-mode-context",
};

function contentText(content: CustomMessageContent): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n\n");
}

function modeContexts(messages: AgentMessage[], kind: ModeKind): CustomMessage[] {
	const customType = MODE_CUSTOM_TYPE[kind];
	return messages.filter(
		(message): message is CustomMessage => message.role === "custom" && message.customType === customType,
	);
}

describe("AgentSession mode context dedupe", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-mode-context-dedupe-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(turns: number): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model");
		const mock = createMockModel({
			responses: Array.from({ length: turns }, () => ({ content: ["Done"] })),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"plan.enabled": true,
				"goal.enabled": true,
				"todo.enabled": false,
			}),
			modelRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});
		sessions.push(session);
		return session;
	}

	function enableMode(session: AgentSession, kind: ModeKind): void {
		switch (kind) {
			case "plan":
				session.setPlanModeState({
					enabled: true,
					planFilePath: "local://PLAN.md",
					workflow: "parallel",
					reentry: false,
				});
				break;
			case "goal":
				session.setGoalModeState({
					enabled: true,
					mode: "active",
					goal: {
						id: "goal-1",
						objective: "Ship the release",
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: 1,
						updatedAt: 1,
					},
				});
				break;
			case "vibe":
				session.setVibeModeState({ enabled: true });
				break;
		}
	}

	function sendModeContext(
		session: AgentSession,
		kind: ModeKind,
		options: { deliverAs?: "steer" | "followUp" | "nextTurn" } = {},
	): Promise<void> {
		switch (kind) {
			case "plan":
				return session.sendPlanModeContext(options);
			case "goal":
				return session.sendGoalModeContext(options);
			case "vibe":
				return session.sendVibeModeContext(options);
		}
	}

	async function steerModeContextWhileStreaming(session: AgentSession, kind: ModeKind): Promise<void> {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		try {
			await sendModeContext(session, kind, { deliverAs: "steer" });
		} finally {
			delete (session as { isStreaming?: unknown }).isStreaming;
		}
		const steered = session.agent.popLastSteer();
		if (!steered) throw new Error(`Expected a queued ${kind} steer`);
		session.agent.appendMessage(steered);
		session.agent.clearAllQueues();
	}

	for (const kind of ["plan", "goal", "vibe"] as const) {
		it(`injects ${kind} context once across consecutive turns`, async () => {
			const session = createSession(2);
			enableMode(session, kind);

			await session.prompt("first turn");
			expect(modeContexts(session.messages, kind)).toHaveLength(1);

			await session.prompt("second turn");
			expect(modeContexts(session.messages, kind)).toHaveLength(1);
		});

		it(`does not re-inject ${kind} context already persisted by a streaming steer`, async () => {
			const session = createSession(1);
			enableMode(session, kind);
			await steerModeContextWhileStreaming(session, kind);
			expect(modeContexts(session.messages, kind)).toHaveLength(1);

			await session.prompt("prompt after steer");
			expect(modeContexts(session.messages, kind)).toHaveLength(1);
		});
	}

	it("re-injects the latest plan context once when its content changes", async () => {
		const session = createSession(3);
		enableMode(session, "plan");

		await session.prompt("first turn");
		const [initial] = modeContexts(session.messages, "plan");
		if (!initial) throw new Error("Expected initial plan context");

		session.setPlanModeState({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: true,
		});
		await session.prompt("changed turn");
		await session.prompt("unchanged turn");

		const contexts = modeContexts(session.messages, "plan");
		expect(contexts).toHaveLength(2);
		const contents = contexts.map(message => contentText(message.content));
		expect(new Set(contents).size).toBe(contents.length);
		expect(contents.at(-1)).not.toBe(contents[0]);
	});

	it("re-injects the latest goal context once when its objective changes", async () => {
		const session = createSession(3);
		enableMode(session, "goal");

		await session.prompt("first turn");
		const [initial] = modeContexts(session.messages, "goal");
		if (!initial) throw new Error("Expected initial goal context");

		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-2",
				objective: "Ship the corrected release",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 2,
				updatedAt: 2,
			},
		});
		await session.prompt("changed turn");
		await session.prompt("unchanged turn");

		const contexts = modeContexts(session.messages, "goal");
		expect(contexts).toHaveLength(2);
		const contents = contexts.map(message => contentText(message.content));
		expect(new Set(contents).size).toBe(contents.length);
		expect(contents.at(-1)).toContain("Ship the corrected release");
		expect(contents.at(-1)).not.toBe(contents[0]);
	});
});
