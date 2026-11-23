/** Delegate work to subagents. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { TaskTool } from "@musepi/pi-coding-agent/task";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `task`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "task"), "tool-task:task");
	ctx.effect!(
		registerToolProvider("task", session => TaskTool.create(session)),
		"tool-task:provide",
	);
}
