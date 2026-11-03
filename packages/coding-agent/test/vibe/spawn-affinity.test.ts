/**
 * Contract: a vibe worker's spawn options join the parent conversation's
 * provider affinity while the worker keeps its own provider session.
 *
 * The worker is a real task-executor subagent, so `#buildSpawnOptions` must
 * forward the same `parentPromptCacheKey` the `task`/eval frontends do.
 * Nested workers read the already-inherited key from their own registry entry
 * and keep the original root instead of pinning to their own session id.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@musepi/pi-coding-agent/async/job-manager";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@musepi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import type { ExecutorOptions } from "@musepi/pi-coding-agent/task/executor";
import * as executorModule from "@musepi/pi-coding-agent/task/executor";
import type { SingleResult } from "@musepi/pi-coding-agent/task/types";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { type VibeCli, VibeSessionRegistry } from "@musepi/pi-coding-agent/vibe/runtime";

function completed(options: ExecutorOptions): SingleResult {
	return {
		index: 0,
		id: options.id,
		agent: options.agent.name,
		agentSource: "bundled",
		task: options.task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

/**
 * A parent session whose live AgentSession is registered under `id`, mirroring
 * the SDK tool session that backs every real task/vibe spawn.
 */
function parentSession(
	registry: AgentRegistry,
	id: string,
	agent: { promptCacheKey?: string; sessionId: string },
): ToolSession {
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		session: { agent } as unknown as AgentSession,
	});
	return {
		cwd: "/tmp",
		settings: Settings.isolated({
			modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
		}),
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		agentRegistry: registry,
		getAgentId: () => id,
		getSessionId: () => `${id}-local`,
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

/** Spawn one worker and return the ExecutorOptions the vibe path handed the executor. */
async function spawnAndCaptureOptions(session: ToolSession, cli: VibeCli, name: string): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return completed(options);
	});

	await VibeSessionRegistry.global().spawn(session, { cli, name, prompt: "work" });
	return captured.promise;
}

describe("vibe worker spawn affinity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("forwards the parent's effective affinity to the worker", async () => {
		const registry = new AgentRegistry();
		const parent = parentSession(registry, "Director", {
			promptCacheKey: "root-affinity",
			sessionId: "director-provider-session",
		});

		const options = await spawnAndCaptureOptions(parent, "good", "RootWorker");

		expect(options.parentPromptCacheKey).toBe("root-affinity");
		expect(options.parentPromptCacheKey).not.toBe("director-provider-session");
	});

	it("falls back to the parent's provider session id without a pinned key", async () => {
		const registry = new AgentRegistry();
		const parent = parentSession(registry, "Director", { sessionId: "director-provider-session" });

		const options = await spawnAndCaptureOptions(parent, "good", "RootWorker");

		expect(options.parentPromptCacheKey).toBe("director-provider-session");
	});

	it("keeps the root affinity when a worker spawns a nested worker", async () => {
		const registry = new AgentRegistry();
		const director = parentSession(registry, "Director", {
			promptCacheKey: "root-affinity",
			sessionId: "director-provider-session",
		});
		const rootOptions = await spawnAndCaptureOptions(director, "good", "RootWorker");

		// The first worker's live session carries the inherited key but its own
		// provider session id, exactly what the SDK builds from the spawn options.
		const worker = parentSession(registry, "Worker", {
			promptCacheKey: rootOptions.parentPromptCacheKey,
			sessionId: "worker-provider-session",
		});
		const nestedOptions = await spawnAndCaptureOptions(worker, "good", "NestedWorker");

		expect(rootOptions.parentPromptCacheKey).toBe("root-affinity");
		expect(nestedOptions.parentPromptCacheKey).toBe("root-affinity");
		expect(nestedOptions.parentPromptCacheKey).not.toBe("worker-provider-session");
	});
});
