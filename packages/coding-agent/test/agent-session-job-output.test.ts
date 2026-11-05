/**
 * Question-job integration: a `question`-kind async job owned by a session
 * exposes its live output through the session (feeds `session.jobs` /
 * `session.jobOutput`) and its completion reaches the conversation as a
 * follow-up turn, which is how a background ask's answer arrives.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@musepi/pi-agent-core";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { AsyncJobManager } from "@musepi/pi-coding-agent/async";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

const AGENT_ID = "Main";

describe("AgentSession question job delivery", () => {
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		AsyncJobManager.resetForTests();
	});

	async function createSession(manager: AsyncJobManager) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		AsyncJobManager.setInstance(manager);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: AGENT_ID,
			asyncJobManager: manager,
		});
		return { session, mock };
	}

	it("exposes question metadata and output, then injects the answer as a follow-up turn", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const gate = Promise.withResolvers<string>();
		const { session: activeSession, mock } = await createSession(manager);

		const jobId = manager.register("task", "Ask: Which auth method?", () => gate.promise, {
			kind: "question",
			questionCount: 1,
			toolCallId: "call-1",
			ownerId: AGENT_ID,
		});
		// While the question is pending, the snapshot carries the question
		// metadata that the jobs HUD renders and no output bytes yet.
		const run = manager.getJob(jobId)!.promise;
		expect(activeSession.getAsyncJobSnapshot()?.running.find(item => item.id === jobId)).toMatchObject({
			kind: "question",
			questionCount: 1,
			toolCallId: "call-1",
			outputBytes: 0,
		});

		gate.resolve("User selected: JWT");
		await run;
		await activeSession.settleAsyncWork();

		expect(activeSession.getAsyncJobOutput(jobId)).toEqual({ output: "User selected: JWT", truncated: false });
		expect(activeSession.getAsyncJobOutput(jobId, { tail: 3 })).toEqual({ output: "JWT", truncated: true });
		expect(activeSession.getAsyncJobOutput("bg_missing")).toBeUndefined();

		const sawAnswer = mock.calls.some(call =>
			call.context.messages.some(message =>
				typeof message.content === "string"
					? message.content.includes("User selected: JWT")
					: message.content.some(block => block.type === "text" && block.text.includes("User selected: JWT")),
			),
		);
		expect(sawAnswer).toBe(true);
	});

	it("refuses output for a job owned by another agent", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const gate = Promise.withResolvers<string>();
		const { session: activeSession } = await createSession(manager);

		const foreignJob = manager.register("task", "Ask: theirs", () => gate.promise, {
			kind: "question",
			ownerId: "SubAgent",
		});

		expect(activeSession.getAsyncJobOutput(foreignJob)).toBeUndefined();
		gate.resolve("not for us");
		await manager.getJob(foreignJob)!.promise;
	});
});
