import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
 * Mode-context exit markers and resume/branch history dedupe.
 *
 * Contract:
 * 1. Exiting plan/goal/vibe mode delivers ONE clear marker (same customType as
 *    the active context) so the stale active constraints stop being the latest
 *    word; the marker is never re-delivered once it is the latest copy.
 * 2. Re-entering a mode after an exit delivers a fresh active context.
 * 3. A mode that was never active delivers nothing (no marker without a prior
 *    live context to clear).
 * 4. Resume/branch: delivery dedupes against the loaded history — an identical
 *    restored context is not re-delivered, and a stale active context in a
 *    resumed/branched session whose mode is off is cleared exactly once.
 */

type ModeKind = "plan" | "goal" | "vibe";

const MODE_CUSTOM_TYPE: Record<ModeKind, string> = {
	plan: "plan-mode-context",
	goal: "goal-mode-context",
	vibe: "vibe-mode-context",
};

/** Stable phrase every exit marker carries. */
const CLEARED_MARKER_PHRASE = "no longer active";

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

function clearedMarkers(messages: AgentMessage[], kind: ModeKind): CustomMessage[] {
	return modeContexts(messages, kind).filter(message => contentText(message.content).includes(CLEARED_MARKER_PHRASE));
}

function activeContexts(messages: AgentMessage[], kind: ModeKind): CustomMessage[] {
	return modeContexts(messages, kind).filter(message => !contentText(message.content).includes(CLEARED_MARKER_PHRASE));
}

describe("AgentSession mode context exit markers", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-mode-exit-marker-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(turns: number, sessionManager: SessionManager = SessionManager.inMemory()): AgentSession {
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
			sessionManager,
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

	function disableMode(session: AgentSession, kind: ModeKind): void {
		switch (kind) {
			case "plan":
				session.setPlanModeState(undefined);
				break;
			case "goal":
				session.setGoalModeState(undefined);
				break;
			case "vibe":
				session.setVibeModeState(undefined);
				break;
		}
	}

	for (const kind of ["plan", "goal", "vibe"] as const) {
		it(`delivers exactly one ${kind} clear marker after the mode exits`, async () => {
			const session = createSession(4);
			enableMode(session, kind);

			await session.prompt("enter turn");
			expect(activeContexts(session.messages, kind)).toHaveLength(1);
			expect(clearedMarkers(session.messages, kind)).toHaveLength(0);

			disableMode(session, kind);
			await session.prompt("exit turn");
			expect(clearedMarkers(session.messages, kind)).toHaveLength(1);

			// The marker is the latest word and is never re-delivered.
			await session.prompt("after exit turn");
			await session.prompt("still after exit");
			expect(clearedMarkers(session.messages, kind)).toHaveLength(1);
			expect(modeContexts(session.messages, kind)).toHaveLength(2);
		});

		it(`re-delivers a fresh ${kind} active context after re-entry following an exit marker`, async () => {
			const session = createSession(5);
			enableMode(session, kind);
			await session.prompt("enter turn");

			disableMode(session, kind);
			await session.prompt("exit turn");
			expect(clearedMarkers(session.messages, kind)).toHaveLength(1);

			enableMode(session, kind);
			await session.prompt("re-enter turn");
			expect(activeContexts(session.messages, kind)).toHaveLength(2);
			await session.prompt("post re-enter turn");
			expect(activeContexts(session.messages, kind)).toHaveLength(2);
		});

		it(`delivers no ${kind} marker when the mode was never active`, async () => {
			const session = createSession(2);
			await session.prompt("first turn");
			await session.prompt("second turn");
			expect(modeContexts(session.messages, kind)).toHaveLength(0);
		});
	}
});

describe("AgentSession mode context resume/branch history dedupe", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-mode-resume-dedupe-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	const sessionDir = () => tempDir.join("sessions");

	function createSession(turns: number, sessionManager: SessionManager): AgentSession {
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
			sessionManager,
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

	/** Build a session on a manager whose history is pre-seeded from `seed`. */
	function createSeededSession(manager: SessionManager, seed: () => void, turns: number): AgentSession {
		seed();
		const context = manager.buildSessionContext();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model");
		const mock = createMockModel({
			responses: Array.from({ length: turns }, () => ({ content: ["Done"] })),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: context.messages },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
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

	async function capturePlanContextContent(): Promise<string> {
		const session = createSession(1, SessionManager.inMemory());
		session.setPlanModeState({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: false,
		});
		await session.prompt("capture turn");
		const [context] = modeContexts(session.messages, "plan");
		if (!context) throw new Error("Expected a delivered plan-mode context");
		return contentText(context.content);
	}

	it("does not re-deliver a plan context already present in resumed history", async () => {
		const planContent = await capturePlanContextContent();
		const sourceManager = SessionManager.create(tempDir.path(), sessionDir());
		sourceManager.appendCustomMessageEntry("plan-mode-context", planContent, false, undefined, "agent");
		const sessionFile = sourceManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		await sourceManager.ensureOnDisk();

		const resumedManager = await SessionManager.open(sessionFile, sessionDir());
		const session = createSeededSession(resumedManager, () => {}, 2);
		// The reconciler restores plan mode with the identical state on resume.
		session.setPlanModeState({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: false,
		});

		await session.prompt("resumed turn");
		await session.prompt("resumed turn two");
		expect(modeContexts(session.messages, "plan")).toHaveLength(1);
	});

	it("clears a stale plan context in resumed history exactly once when the mode is off", async () => {
		const planContent = await capturePlanContextContent();
		const sourceManager = SessionManager.create(tempDir.path(), sessionDir());
		sourceManager.appendCustomMessageEntry("plan-mode-context", planContent, false, undefined, "agent");
		const sessionFile = sourceManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		await sourceManager.ensureOnDisk();

		const resumedManager = await SessionManager.open(sessionFile, sessionDir());
		const session = createSeededSession(resumedManager, () => {}, 3);

		await session.prompt("resumed turn");
		expect(clearedMarkers(session.messages, "plan")).toHaveLength(1);
		await session.prompt("resumed turn two");
		expect(clearedMarkers(session.messages, "plan")).toHaveLength(1);
		expect(modeContexts(session.messages, "plan")).toHaveLength(2);
	});

	it("clears a stale plan context in a branched session exactly once when the mode is off", async () => {
		const planContent = await capturePlanContextContent();
		const sourceManager = SessionManager.create(tempDir.path(), sessionDir());
		sourceManager.appendCustomMessageEntry("plan-mode-context", planContent, false, undefined, "agent");
		const sessionFile = sourceManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		await sourceManager.ensureOnDisk();

		const branchManager = await SessionManager.forkFrom(sessionFile, tempDir.path(), sessionDir());
		const session = createSeededSession(branchManager, () => {}, 3);

		await session.prompt("branch turn");
		expect(clearedMarkers(session.messages, "plan")).toHaveLength(1);
		await session.prompt("branch turn two");
		expect(clearedMarkers(session.messages, "plan")).toHaveLength(1);
		expect(activeContexts(session.messages, "plan")).toHaveLength(1);
	});
});
