/** 回滚检查点工具。 */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { RewindTool } from "@musepi/pi-coding-agent/tools/checkpoint";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `rewind`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "rewind"), "tool-rewind:rewind");
	ctx.effect!(
		registerToolProvider("rewind", session => RewindTool.createIf(session)),
		"tool-rewind:provide",
	);
}
