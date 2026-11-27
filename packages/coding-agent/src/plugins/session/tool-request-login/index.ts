/** Ask the user to save a website sign-in the agent fills but never sees. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { RequestLoginTool } from "@musepi/pi-coding-agent/tools/request-login";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `request_login`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "request"), "tool-request-login:request");
	ctx.effect!(
		registerToolProvider("request_login", session => new RequestLoginTool(session)),
		"tool-request-login:provide",
	);
}
