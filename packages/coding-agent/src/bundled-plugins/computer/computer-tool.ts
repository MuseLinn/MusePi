import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";

export default function computerTool(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "computer"), "tool:computer");
}
