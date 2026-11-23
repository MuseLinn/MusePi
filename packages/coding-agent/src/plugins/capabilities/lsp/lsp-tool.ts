import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { LspTool } from "../../../lsp/tool";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** The lsp package provides `lsp`. */
export default function lspTool(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "lsp"), "tool:lsp");
	ctx.effect!(
		registerToolProvider("lsp", session => LspTool.createIf(session)),
		"lsp:provide",
	);
}
