import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function lspTool(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("tool", "lsp"), "tool:lsp");
}
