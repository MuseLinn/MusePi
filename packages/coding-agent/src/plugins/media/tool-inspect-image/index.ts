/** Vision inspection of an image. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { InspectImageTool } from "@musepi/pi-coding-agent/tools/inspect-image";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `inspect_image`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "inspect"), "tool-inspect-image:inspect");
	ctx.effect!(
		registerToolProvider("inspect_image", session => new InspectImageTool(session)),
		"tool-inspect-image:provide",
	);
}
