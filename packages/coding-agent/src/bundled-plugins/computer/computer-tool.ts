import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { ComputerTool } from "../../tools/computer";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The computer package provides `computer`. */
export default function computerTool(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "computer"), "tool:computer");
	ctx.effect!(
		registerToolProvider("computer", session => new ComputerTool(session)),
		"computer:provide",
	);
}
