import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { RewindTool } from "../../../tools/checkpoint";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** Provides `rewind`. */
export default function rewind(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "rewind"), "tool-rewind:rewind");
	ctx.effect!(
		registerToolProvider("rewind", session => RewindTool.createIf(session)),
		"tool-rewind:provide",
	);
}
