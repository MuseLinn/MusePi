import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function computerTool(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("tool", "computer"), "tool:computer");
}
