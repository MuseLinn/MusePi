import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { InspectImageTool } from "../../tools/inspect-image";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The image package provides `inspect_image`. */
export default function inspect(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "inspect_image"), "tools-image:inspect");
	ctx.effect!(
		registerToolProvider("inspect_image", session => new InspectImageTool(session)),
		"tools-image:provide:inspect",
	);
}
