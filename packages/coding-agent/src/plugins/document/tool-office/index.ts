/** Reads text and structure from Office Open XML files (`office_read`). */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { OfficeReadTool } from "@musepi/pi-coding-agent/tools/office";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";
import type { Config } from "./config";

export { Config } from "./config";

/** Provides `office_read`. */
export function apply(ctx: PluginAPI, config?: Config): void {
	const maxChars = config?.maxChars ?? 120000;
	ctx.effect(activateCapability("tool", "office"), "tool-office:office_read");
	ctx.effect(
		registerToolProvider("office_read", session => new OfficeReadTool(session, maxChars), {
			packageName: "musepi-tool-office",
		}),
		"tool-office:provide",
	);
}
