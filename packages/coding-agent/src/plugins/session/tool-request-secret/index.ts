/** Ask the user for a secret. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { RequestSecretTool } from "@musepi/pi-coding-agent/tools/request-secret";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `request_secret`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "request"), "tool-request-secret:request");
	ctx.effect!(
		registerToolProvider("request_secret", session => new RequestSecretTool(session)),
		"tool-request-secret:provide",
	);
}
