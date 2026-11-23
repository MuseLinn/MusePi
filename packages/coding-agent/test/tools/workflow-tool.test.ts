import { afterAll, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@musepi/pi-coding-agent/async/job-manager";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@musepi/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { WorkflowTool } from "@musepi/pi-coding-agent/tools/workflow";

const managers: AsyncJobManager[] = [];

function session(manager?: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => "Main",
		settings: Settings.isolated(),
		...(manager === undefined ? {} : { asyncJobManager: manager }),
	} as unknown as ToolSession;
}

describe("workflow", () => {
	afterAll(async () => {
		for (const manager of managers) manager.dispose();
		await disposeAllVmContexts();
	});

	it("runs the script with args in the JS kernel", async () => {
		const result = await new WorkflowTool(session(), 10_000).execute("call", {
			name: "args-probe",
			script: "console.log(JSON.stringify(args));",
			args: { answer: 42 },
		});
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain('{"answer":42}');
		expect(result.details?.name).toBe("args-probe");
	});

	it("refuses an empty script", async () => {
		await expect(new WorkflowTool(session()).execute("call", { name: "empty", script: "  " })).rejects.toThrow(
			"script must not be empty",
		);
	});

	it("runs in the background as a workflow job and returns its id at once", async () => {
		const manager = new AsyncJobManager({});
		managers.push(manager);
		const tool = new WorkflowTool(session(manager), 10_000);
		const result = await tool.execute("call", {
			name: "bg-probe",
			description: "background probe",
			script: "console.log('background ran');",
			run_in_background: true,
		});
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(result.details).toMatchObject({ name: "bg-probe", background: true });
		const jobId = result.details?.jobId;
		expect(jobId).toBeDefined();
		expect(text).toContain(jobId!);
		const job = manager.getJob(jobId!);
		expect(job).toMatchObject({ kind: "workflow", type: "task", label: "workflow bg-probe" });
		await job!.promise;
		expect(manager.getJobOutput(jobId!)?.output).toContain("background ran");
		expect(manager.getJobOutput(jobId!)?.output).toContain("Workflow bg-probe: background probe");
	});

	it("refuses a background run without a job manager", async () => {
		await expect(
			new WorkflowTool(session()).execute("call", {
				name: "no-manager",
				script: "return 1;",
				run_in_background: true,
			}),
		).rejects.toThrow("background runs are unavailable");
	});
});
