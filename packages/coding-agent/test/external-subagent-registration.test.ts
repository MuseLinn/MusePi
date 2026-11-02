import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { TaskTool } from "@musepi/pi-coding-agent/task";
import * as discoveryModule from "@musepi/pi-coding-agent/task/discovery";
import { resolveEffectiveSubagentPolicy } from "@musepi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@musepi/pi-coding-agent/task/types";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";

function createRunner(): ExtensionRunner {
	const runtime = { flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime;
	return new ExtensionRunner([], runtime, "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
}

function createSession(extensionRunner?: ExtensionRunner): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		extensionRunner,
	} as unknown as ToolSession;
}

const externalAgent: AgentDefinition = {
	name: "codex",
	description: "Experimental Codex subagent",
	systemPrompt: "",
	source: "extension",
	external: async () => ({ output: "done" }),
};

afterEach(() => vi.restoreAllMocks());

describe("external subagent registration", () => {
	it("accepts an external executor without a local system prompt", () => {
		const runner = createRunner();
		runner.registerSubagent({
			name: "codex",
			description: "Experimental Codex subagent",
			external: async () => ({ output: "done" }),
		});
		expect(runner.listRegisteredSubagents()).toHaveLength(1);
		expect(runner.listRegisteredSubagents()[0]).toMatchObject({ systemPrompt: "", source: "extension" });
	});

	it("keeps the local system-prompt requirement for ordinary agents", () => {
		const runner = createRunner();
		expect(() => runner.registerSubagent({ name: "local", description: "Local agent", systemPrompt: "" })).toThrow(
			"non-empty systemPrompt",
		);
	});

	it("publishes registered agents in the live task description and removes them on unregister", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const runner = createRunner();
		const tool = await TaskTool.create(createSession(runner));
		runner.registerSubagent({
			name: "codex",
			description: "Experimental Codex subagent",
			external: async () => ({ output: "done" }),
		});
		expect(tool.description).toContain("Experimental Codex subagent");
		runner.unregisterSubagent("codex");
		expect(tool.description).not.toContain("Experimental Codex subagent");
	});

	it("rejects local-only controls before starting an external agent", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const session = createSession(createRunner());
		session.extensionRunner!.listRegisteredSubagents = () => [externalAgent];
		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "Do work",
				agent: "codex",
				model: "openai/gpt-5",
			}),
		).rejects.toThrow("does not support model overrides");
	});
});
