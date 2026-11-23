/** Runs a JavaScript orchestration across subagents (`workflow`). */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";
import { WorkflowTool } from "@musepi/pi-coding-agent/tools/workflow";
import type { Config } from "./config";

export { Config } from "./config";

/** Provides `workflow`. */
export function apply(ctx: PluginAPI, config?: Config): void {
	const maxResultChars = config?.maxResultChars ?? 50000;
	ctx.effect(activateCapability("tool", "workflow"), "tool-workflow:workflow");
	ctx.effect(
		registerToolProvider("workflow", session => new WorkflowTool(session, maxResultChars), {
			packageName: "musepi-tool-workflow",
		}),
		"tool-workflow:provide",
	);
}
