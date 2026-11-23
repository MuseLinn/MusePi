import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { DebugTool } from "../../../tools/debug";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** Provides `debug`. */
export default function debug(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "debug"), "tool-debug:debug");
	ctx.effect!(
		registerToolProvider("debug", session => DebugTool.createIf(session)),
		"tool-debug:provide",
	);
}
