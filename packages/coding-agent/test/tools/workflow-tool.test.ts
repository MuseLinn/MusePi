import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@musepi/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { WorkflowTool } from "@musepi/pi-coding-agent/tools/workflow";

function session(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

describe("workflow", () => {
	afterAll(async () => {
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
});
