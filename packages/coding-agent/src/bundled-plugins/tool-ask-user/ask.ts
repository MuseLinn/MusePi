import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { AskTool } from "../../tools/ask";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `ask`. */
export default function ask(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "ask"), "tool-ask-user:ask");
	ctx.effect!(
		registerToolProvider("ask", session => AskTool.createIf(session)),
		"tool-ask-user:provide",
	);
}
