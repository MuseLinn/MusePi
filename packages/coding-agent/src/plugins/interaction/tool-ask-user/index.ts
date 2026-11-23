/** Ask the user and wait for the answer. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { AskTool } from "@musepi/pi-coding-agent/tools/ask";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `ask`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "ask"), "tool-ask-user:ask");
	ctx.effect!(
		registerToolProvider("ask", session => AskTool.createIf(session)),
		"tool-ask-user:provide",
	);
}
