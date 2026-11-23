/** Operate the host desktop through screenshots, input and the accessibility tree. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { ComputerTool } from "@musepi/pi-coding-agent/tools/computer";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

export { Config } from "./config";

/** The computer package provides `computer`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "computer"), "tool:computer");
	ctx.effect!(
		registerToolProvider("computer", session => new ComputerTool(session)),
		"computer:provide",
	);
}
