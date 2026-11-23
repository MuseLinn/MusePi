import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";

export default function lspTool(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "lsp"), "tool:lsp");
}
