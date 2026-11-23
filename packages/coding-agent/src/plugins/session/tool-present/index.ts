/** Declares existing files as final deliverables (`present`). */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { PresentTool } from "@musepi/pi-coding-agent/tools/present";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";
import type { Config } from "./config";

export { Config } from "./config";

/** Provides `present`. */
export function apply(ctx: PluginAPI, config?: Config): void {
	const maxFiles = config?.maxFiles ?? 8;
	ctx.effect(activateCapability("tool", "present"), "tool-present:present");
	ctx.effect(
		registerToolProvider("present", session => new PresentTool(session, maxFiles), {
			packageName: "musepi-tool-present",
		}),
		"tool-present:provide",
	);
}
