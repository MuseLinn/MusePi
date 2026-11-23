/** Shell command execution. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { BashTool } from "@musepi/pi-coding-agent/tools/bash";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `bash`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "bash"), "tool-bash:bash");
	ctx.effect!(
		registerToolProvider("bash", session => new BashTool(session)),
		"tool-bash:provide",
	);
}
