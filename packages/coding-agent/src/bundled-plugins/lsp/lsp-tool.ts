import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function lspTool(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("tool", "lsp"), "tool:lsp");
}
