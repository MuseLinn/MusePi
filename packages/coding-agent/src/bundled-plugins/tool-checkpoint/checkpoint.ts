import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { CheckpointTool } from "../../tools/checkpoint";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `checkpoint`. */
export default function checkpoint(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "checkpoint"), "tool-checkpoint:checkpoint");
	ctx.effect!(
		registerToolProvider("checkpoint", session => CheckpointTool.createIf(session)),
		"tool-checkpoint:provide",
	);
}
