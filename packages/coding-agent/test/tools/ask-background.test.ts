/**
 * Background ask contract: `background: true` returns a task id without
 * blocking, registers a `question`-kind async job, and delivers the answer
 * through the ordinary async-result channel as a follow-up turn. Cancelling a
 * background dialog must settle the job, never abort the asking turn.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@musepi/pi-agent-core";
import { AsyncJobManager } from "@musepi/pi-coding-agent/async";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ExtensionAskDialogResult } from "@musepi/pi-coding-agent/extensibility/extensions";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { AskTool } from "@musepi/pi-coding-agent/tools/ask";
import { ToolError } from "@musepi/pi-coding-agent/tools/tool-errors";

const OWNER_ID = "Main";

const QUESTIONS = [{ id: "q1", question: "Which auth method?", options: [{ label: "JWT" }] }];

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createContext(args: {
	askDialog: () => Promise<ExtensionAskDialogResult | undefined>;
	abort?: () => void;
}): AgentToolContext {
	return {
		hasUI: true,
		ui: { askDialog: args.askDialog, editor: async () => undefined },
		abort: args.abort ?? (() => {}),
	} as unknown as AgentToolContext;
}

const managers: AsyncJobManager[] = [];

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({});
	managers.push(manager);
	return manager;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) {
		await manager.dispose({ timeoutMs: 50 });
	}
	AsyncJobManager.resetForTests();
});

describe("AskTool background questions", () => {
	it("returns a task id before the answer exists and records question metadata", async () => {
		const manager = createManager();
		const pending = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		const askDialog = vi.fn(() => pending.promise);
		const abort = vi.fn();
		const tool = new AskTool(createSession({ asyncJobManager: manager, getAgentId: () => OWNER_ID }));

		const result = await tool.execute(
			"call-bg-1",
			{ background: true, questions: QUESTIONS },
			undefined,
			undefined,
			createContext({ askDialog, abort }),
		);

		// The tool settled while the dialog is still open — that is the whole point.
		expect(askDialog).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
		expect(result.details?.background).toBe(true);
		const taskId = result.details?.taskId;
		expect(typeof taskId).toBe("string");

		const job = manager.getJob(taskId!);
		expect(job).toMatchObject({
			type: "task",
			kind: "question",
			status: "running",
			questionCount: 1,
			toolCallId: "call-bg-1",
			ownerId: OWNER_ID,
		});
		expect(manager.snapshotJob(job!).questionCount).toBe(1);
		pending.resolve(undefined);
		await job!.promise;
	});

	it("delivers the answer as a completion for the asking agent", async () => {
		const manager = createManager();
		const pending = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		const delivered = Promise.withResolvers<{ jobId: string; text: string }>();
		manager.registerDeliverySink(OWNER_ID, (jobId, text) => {
			delivered.resolve({ jobId, text });
		});
		const tool = new AskTool(createSession({ asyncJobManager: manager, getAgentId: () => OWNER_ID }));

		const result = await tool.execute(
			"call-bg-2",
			{ background: true, questions: QUESTIONS },
			undefined,
			undefined,
			createContext({ askDialog: () => pending.promise }),
		);
		const taskId = result.details?.taskId ?? "";

		pending.resolve({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Which auth method?",
					options: ["JWT"],
					multi: false,
					selectedOptions: ["JWT"],
				},
			],
		});

		const completion = await delivered.promise;
		expect(completion.jobId).toBe(taskId);
		expect(completion.text).toContain("User selected: JWT");
		expect(manager.getJob(taskId)?.status).toBe("completed");
		// The answer is also readable back through the live-output ring.
		expect(manager.getJobOutput(taskId)?.output).toContain("User selected: JWT");
	});

	it("settles without aborting the turn when the background dialog is dismissed", async () => {
		const manager = createManager();
		const pending = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		const delivered = Promise.withResolvers<string>();
		manager.registerDeliverySink(OWNER_ID, (_jobId, text) => {
			delivered.resolve(text);
		});
		const abort = vi.fn();
		const tool = new AskTool(createSession({ asyncJobManager: manager, getAgentId: () => OWNER_ID }));

		const result = await tool.execute(
			"call-bg-3",
			{ background: true, questions: QUESTIONS },
			undefined,
			undefined,
			createContext({ askDialog: () => pending.promise, abort }),
		);
		const taskId = result.details?.taskId ?? "";

		pending.resolve(undefined);

		expect(await delivered.promise).toContain("did not answer");
		expect(abort).not.toHaveBeenCalled();
		expect(manager.getJob(taskId)?.status).toBe("completed");
	});

	it("refuses a background question when the session has no async job manager", async () => {
		const abort = vi.fn();
		const tool = new AskTool(createSession());
		const askDialog = vi.fn(async () => undefined);

		await expect(
			tool.execute(
				"call-bg-4",
				{ background: true, questions: QUESTIONS },
				undefined,
				undefined,
				createContext({ askDialog, abort }),
			),
		).rejects.toThrow(ToolError);
		expect(askDialog).not.toHaveBeenCalled();
	});
});
