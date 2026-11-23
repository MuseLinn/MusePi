import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { BashTool } from "../../../tools/bash";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** Provides `bash`. */
export default function bash(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "bash"), "tool-bash:bash");
	ctx.effect!(
		registerToolProvider("bash", session => new BashTool(session)),
		"tool-bash:provide",
	);
}
