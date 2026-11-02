import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { CordisDynamicPluginRuntime } from "@musepi/pi-coding-agent/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "@musepi/pi-coding-agent/daemon/host-context";
import { ExtensionRunner } from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import type { LoadExtensionsResult } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { TaskTool } from "@musepi/pi-coding-agent/task";
import * as discoveryModule from "@musepi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";

const pluginNames = ["codex", "claude-code", "codebuddy", "kimi-code", "opencode"];
const entries = [
	"subagent-codex",
	"subagent-claude-code",
	"subagent-codebuddy",
	"subagent-kimi-code",
	"subagent-opencode",
].map(directory => path.join(import.meta.dir, "../src/bundled-plugins", directory, "index.ts"));

async function taskDescription(load: LoadExtensionsResult): Promise<string> {
	const runner = new ExtensionRunner(
		load.extensions,
		load.runtime,
		os.tmpdir(),
		{ getCwd: () => os.tmpdir() } as never,
		{} as never,
	);
	expect(runner.listRegisteredSubagents().map(agent => agent.name)).toEqual(
		expect.arrayContaining(load.extensions.flatMap(extension => [...extension.subagents.keys()])),
	);
	const tool = await TaskTool.create({
		cwd: os.tmpdir(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		extensionRunner: runner,
	} as unknown as ToolSession);
	return tool.description;
}

afterEach(() => vi.restoreAllMocks());

describe("external subagent bundled plugins", () => {
	it("loads and unloads real Cordis registrations without spawning a product process", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const spawn = vi.spyOn(Bun, "spawn");
		const host = new DaemonHostContext();
		const runtime = new CordisDynamicPluginRuntime(host);
		try {
			const enabled = await runtime.loadAll(entries, os.tmpdir());
			expect(enabled.errors).toEqual([]);
			expect(enabled.extensions.flatMap(extension => [...extension.subagents.keys()])).toEqual(pluginNames);
			const description = await taskDescription(enabled);
			for (const name of pluginNames) expect(description).toContain(name);

			const disabled = await runtime.loadAll(entries.slice(1), os.tmpdir());
			expect(disabled.errors).toEqual([]);
			expect(disabled.extensions.flatMap(extension => [...extension.subagents.keys()])).not.toContain("codex");
			expect(await taskDescription(disabled)).not.toContain(
				"Experimental: delegate a one-shot coding task to the native Codex app-server.",
			);
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
			await host.dispose();
		}
	});
});
