import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { RewindTool } from "../../tools/checkpoint";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The checkpoint package provides `rewind`. */
export default function rewind(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "rewind"), "tools-checkpoint:rewind");
	ctx.effect!(
		registerToolProvider("rewind", session => new RewindTool(session)),
		"tools-checkpoint:provide:rewind",
	);
}
