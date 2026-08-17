import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { refreshAgentDiscovery, TaskTool } from "@musepi/pi-coding-agent/task";
import * as discoveryModule from "@musepi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

const REFRESHED_AGENTS = [
	{
		name: "task",
		description: "Refreshed task agent",
		systemPrompt: "You are the refreshed task agent.",
		source: "bundled" as const,
	},
];

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("TaskTool.create discovery memo", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuses one discovery scan across repeated creations with the same cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		const first = await TaskTool.create(createSession("/tmp"));
		const second = await TaskTool.create(createSession("/tmp"));

		expect(spy).toHaveBeenCalledTimes(1);
		expect(first.description).toBe(second.description);
	});

	it("rescans for a different cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await TaskTool.create(createSession("/tmp"));
		await TaskTool.create(createSession("/tmp/omp-memo-other"));

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("does not cache a rejected discovery", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await expect(TaskTool.create(createSession("/tmp"))).rejects.toThrow("boom");
		const tool = await TaskTool.create(createSession("/tmp"));

		expect(tool.description).toContain("task");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("publishes refreshed definitions to existing and future tools", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValueOnce({ agents: TEST_AGENTS, projectAgentsDir: null })
			.mockResolvedValueOnce({ agents: REFRESHED_AGENTS, projectAgentsDir: null });
		const session = createSession("/tmp/omp-memo-refresh");
		const existing = await TaskTool.create(session);

		expect(existing.description).toContain("General-purpose task agent");
		await refreshAgentDiscovery(session.cwd);

		expect(existing.description).toContain("Refreshed task agent");
		expect(existing.description).not.toContain("General-purpose task agent");
		const future = await TaskTool.create(session);
		expect(future.description).toContain("Refreshed task agent");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
