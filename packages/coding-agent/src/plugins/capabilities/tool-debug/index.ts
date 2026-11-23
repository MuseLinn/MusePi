/** Session diagnostics and inspection. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { DebugTool } from "@musepi/pi-coding-agent/tools/debug";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `debug`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "debug"), "tool-debug:debug");
	ctx.effect!(
		registerToolProvider("debug", session => DebugTool.createIf(session)),
		"tool-debug:provide",
	);
}
