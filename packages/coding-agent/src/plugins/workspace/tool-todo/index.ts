/** Task checklist. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { TodoTool } from "@musepi/pi-coding-agent/tools/todo";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `todo`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "todo"), "tool-todo:todo");
	ctx.effect!(
		registerToolProvider("todo", session => new TodoTool(session)),
		"tool-todo:provide",
	);
}
