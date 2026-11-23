/** 检查点工具。 */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { CheckpointTool } from "@musepi/pi-coding-agent/tools/checkpoint";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `checkpoint`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "checkpoint"), "tool-checkpoint:checkpoint");
	ctx.effect!(
		registerToolProvider("checkpoint", session => CheckpointTool.createIf(session)),
		"tool-checkpoint:provide",
	);
}
