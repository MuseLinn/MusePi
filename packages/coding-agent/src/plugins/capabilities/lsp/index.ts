/** Definitions, references, diagnostics and rename through language servers. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { LspTool } from "@musepi/pi-coding-agent/lsp/tool";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

export { Config } from "./config";

/** The lsp package provides `lsp`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "lsp"), "tool:lsp");
	ctx.effect!(
		registerToolProvider("lsp", session => LspTool.createIf(session)),
		"lsp:provide",
	);
}
