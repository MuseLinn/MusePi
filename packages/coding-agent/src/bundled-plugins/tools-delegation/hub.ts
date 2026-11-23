import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { HubTool } from "../../tools/hub";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The delegation package provides `hub` (peer messaging, jobs, supervision). */
export default function hub(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "hub"), "tools-delegation:hub");
	ctx.effect!(
		registerToolProvider("hub", session => new HubTool(session)),
		"tools-delegation:provide:hub",
	);
}
