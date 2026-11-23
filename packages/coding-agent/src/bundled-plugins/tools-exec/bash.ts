import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { BashTool } from "../../tools/bash";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The exec package provides `bash`. */
export default function bash(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "bash"), "tools-exec:bash");
	ctx.effect!(
		registerToolProvider("bash", session => new BashTool(session)),
		"tools-exec:provide:bash",
	);
}
