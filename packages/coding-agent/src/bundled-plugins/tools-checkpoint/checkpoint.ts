import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { CheckpointTool } from "../../tools/checkpoint";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The checkpoint package provides `checkpoint`. */
export default function checkpoint(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "checkpoint"), "tools-checkpoint:checkpoint");
	ctx.effect!(
		registerToolProvider("checkpoint", session => new CheckpointTool(session)),
		"tools-checkpoint:provide:checkpoint",
	);
}
