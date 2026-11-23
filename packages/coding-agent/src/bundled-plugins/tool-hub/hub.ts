import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { HubTool } from "../../tools/hub";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `hub`. */
export default function hub(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "hub"), "tool-hub:hub");
	ctx.effect!(
		registerToolProvider("hub", session => new HubTool(session)),
		"tool-hub:provide",
	);
}
