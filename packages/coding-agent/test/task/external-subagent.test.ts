import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ExecutorOptions } from "@musepi/pi-coding-agent/task/executor";
import { runExternalSubagent } from "@musepi/pi-coding-agent/task/external";
import {
	type AgentDefinition,
	type ExternalSubagentExecutor,
	MAX_OUTPUT_LINES,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@musepi/pi-coding-agent/task/types";
import { EventBus } from "@musepi/pi-coding-agent/utils/event-bus";

function options(external: ExternalSubagentExecutor, artifactsDir?: string): ExecutorOptions {
	const agent: AgentDefinition = {
		name: "external-worker",
		description: "External test worker",
		systemPrompt: "",
		source: "extension",
		external,
	};
	return {
		cwd: os.tmpdir(),
		agent,
		task: "Perform the external task.",
		assignment: "Perform the external task.",
		index: 2,
		id: "ExternalWorker",
		artifactsDir,
		settings: Settings.isolated({}),
		maxRuntimeMs: 0,
	};
}

describe("external subagent execution", () => {
	it("uses the shared progress, lifecycle, result, and artifact contracts", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-external-result-"));
		const eventBus = new EventBus();
		const lifecycle: Array<{ status?: string }> = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, value => lifecycle.push(value as { status?: string }));
		try {
			const result = await runExternalSubagent({
				...options(async context => {
					context.report({ output: "working", currentTool: "compiler" });
					return { output: "external answer", resolvedModel: "native/model" };
				}, artifactsDir),
				eventBus,
			});
			expect(result).toMatchObject({
				index: 2,
				id: "ExternalWorker",
				agentSource: "extension",
				exitCode: 0,
				output: "external answer",
				requests: 1,
				resolvedModel: "native/model",
			});
			expect(await fs.readFile(path.join(artifactsDir, "ExternalWorker.md"), "utf8")).toBe("external answer");
			expect(lifecycle.map(event => event.status)).toEqual(["started", "completed"]);
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true });
		}
	});

	it("fails an empty successful answer instead of returning a false completion", async () => {
		const result = await runExternalSubagent(options(async () => ({ output: "  " })));
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("empty response");
	});

	it("applies the standard output line cap while retaining the complete artifact", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-external-cap-"));
		try {
			const output = Array.from({ length: MAX_OUTPUT_LINES + 2 }, (_, index) => `line-${index}`).join("\n");
			const result = await runExternalSubagent(options(async () => ({ output }), artifactsDir));
			expect(result.truncated).toBe(true);
			expect(result.output.split("\n").length).toBeLessThan(output.split("\n").length);
			expect(await fs.readFile(path.join(artifactsDir, "ExternalWorker.md"), "utf8")).toBe(output);
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true });
		}
	});

	it("maps executor failure and caller cancellation to settled task results", async () => {
		const failed = await runExternalSubagent(
			options(async () => {
				throw new Error("protocol broke");
			}),
		);
		expect(failed).toMatchObject({ exitCode: 1, error: "protocol broke", aborted: false });

		const controller = new AbortController();
		controller.abort("stop now");
		const aborted = await runExternalSubagent({
			...options(async () => ({ output: "too late" })),
			signal: controller.signal,
		});
		expect(aborted).toMatchObject({ exitCode: 1, aborted: true, output: "" });
	});
});
