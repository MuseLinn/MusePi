/**
 * Contract: a running foreground (blocking) spawn can be moved to the
 * background mid-turn. The tool returns a placeholder immediately, the same
 * run keeps executing, and its result arrives as one `task` job. The spawn
 * semaphore slot moves with it: with `task.maxConcurrency = 1` a second
 * inline spawn stays queued until the detached run settles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@musepi/pi-coding-agent/async/job-manager";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@musepi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@musepi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@musepi/pi-coding-agent/task";
import { requestAgentDetach } from "@musepi/pi-coding-agent/task/detach-registry";
import * as discoveryModule from "@musepi/pi-coding-agent/task/discovery";
import * as executorModule from "@musepi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@musepi/pi-coding-agent/task/types";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";

/** `blocking: true` keeps this agent on the inline (foreground) path. */
const blockingAgent: AgentDefinition = {
	name: "blocker",
	description: "Blocking task agent",
	systemPrompt: "You are a blocking task agent.",
	source: "bundled",
	blocking: true,
};

function createSession(options: { manager?: AsyncJobManager; settings?: Record<string, unknown> }): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "blocker",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

/**
 * Retry until the run's progress frame has published its detach handle. A
 * miss is side-effect free (nothing registered yet), so polling is safe.
 */
async function detachWhenReady(agentId: string): Promise<{ ok: boolean; jobId?: string; error?: string }> {
	const start = Date.now();
	for (;;) {
		const result = await requestAgentDetach(agentId);
		if (result.ok || Date.now() - start > 2000) return result;
		await Bun.sleep(5);
	}
}

describe("task detach (foreground → background)", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("returns a placeholder, keeps the run alive, and delivers it as one job", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [blockingAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const pending = tool.execute("tc-detach", {
			agent: "blocker",
			name: "Detacher",
			task: "Do the thing.",
		} as TaskParams);
		await pollUntil(() => started.length === 1);
		const agentId = started[0]!;

		const detached = await detachWhenReady(agentId);
		expect(detached.ok).toBe(true);
		const jobId = detached.jobId!;

		// The current turn stops waiting: placeholder payload, no results.
		const result = await pending;
		const text = getFirstText(result);
		expect(text).toContain(`Agent \`${agentId}\` is now running in the background`);
		expect(text).toContain(`job \`${jobId}\``);
		expect(result.details?.results).toEqual([]);

		const job = manager.getJob(jobId);
		expect(job?.type).toBe("task");
		expect(job?.agentId).toBe(agentId);
		// Same owner scope as a natively background spawn, so `hub jobs` and
		// delivery routing see the adopted job.
		expect(job?.ownerId).toBe("Main");
		expect(job?.status).toBe("running");
		expect(runSpy).toHaveBeenCalledTimes(1);

		// The permit moved with the run: a second inline spawn cannot start
		// while the detached one still holds the only slot.
		const second = tool.execute("tc-next", {
			agent: "blocker",
			name: "Second",
			task: "Work B.",
		} as TaskParams);
		await Bun.sleep(50);
		expect(started).toHaveLength(1);

		gates.get(agentId)!.resolve();
		await job!.promise;
		expect(job?.status).toBe("completed");
		expect(job?.resultText).toContain(agentId);
		expect(job?.resultText).toContain("All done.");

		await pollUntil(() => started.length === 2);
		gates.get(started[1]!)!.resolve();
		const secondResult = await second;
		expect(secondResult.details?.results[0]?.id).toBe(started[1]);
	});

	it("stops forwarding the turn abort once the run is detached", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [blockingAgent],
			projectAgentsDir: null,
		});
		const signals = new Map<string, AbortSignal>();
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			if (options.signal) signals.set(id, options.signal);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const turn = new AbortController();
		const pending = tool.execute(
			"tc-abort",
			{ agent: "blocker", name: "Stopper", task: "Do the thing." } as TaskParams,
			turn.signal,
		);
		await pollUntil(() => signals.size === 1);
		const agentId = [...signals.keys()][0]!;
		const runSignal = signals.get(agentId)!;
		expect(runSignal.aborted).toBe(false);

		// Foreground: the turn owns the run, so stopping the turn stops it.
		turn.abort(new Error("stop turn"));
		expect(runSignal.aborted).toBe(true);
		gates.get(agentId)!.resolve();
		await pending;
	});

	it("a detached run survives a later turn abort", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [blockingAgent],
			projectAgentsDir: null,
		});
		const signals = new Map<string, AbortSignal>();
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			if (options.signal) signals.set(id, options.signal);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		// Two controllers: an inner one the test drives separately, because the
		// run must outlive the turn that launched it.
		const turn = new AbortController();
		const pending = tool.execute(
			"tc-survive",
			{ agent: "blocker", name: "Survivor", task: "Do the thing." } as TaskParams,
			turn.signal,
		);
		await pollUntil(() => signals.size === 1);
		const agentId = [...signals.keys()][0]!;
		const runSignal = signals.get(agentId)!;

		const detached = await detachWhenReady(agentId);
		expect(detached.ok).toBe(true);
		await pending;
		turn.abort(new Error("stop turn"));
		expect(runSignal.aborted).toBe(false);

		gates.get(agentId)!.resolve();
		await manager.getJob(detached.jobId!)!.promise;
		expect(manager.getJob(detached.jobId!)?.status).toBe("completed");
	});

	it("reports an unknown agent instead of throwing", async () => {
		expect(await requestAgentDetach("Nobody")).toEqual({
			ok: false,
			error: "agent is not running in the foreground",
		});
	});
});
