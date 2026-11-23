import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { TaskTool } from "../../../task";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** Provides `task`. */
export default function task(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "task"), "tool-task:task");
	ctx.effect!(
		registerToolProvider("task", session => TaskTool.create(session)),
		"tool-task:provide",
	);
}
