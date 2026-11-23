import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { TodoTool } from "../../tools/todo";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The session package provides `todo`. */
export default function todo(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "todo"), "tools-session:todo");
	ctx.effect!(
		registerToolProvider("todo", session => new TodoTool(session)),
		"tools-session:provide:todo",
	);
}
