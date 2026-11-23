/** Peer messaging, jobs and supervision. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { HubTool } from "@musepi/pi-coding-agent/tools/hub";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `hub`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "hub"), "tool-hub:hub");
	ctx.effect!(
		registerToolProvider("hub", session => new HubTool(session)),
		"tool-hub:provide",
	);
}
