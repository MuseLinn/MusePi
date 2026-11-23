/** Reads and converts Office Open XML files (`office_render` / `office_convert`). */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { OfficeConvertTool, OfficeRenderTool } from "@musepi/pi-coding-agent/tools/office";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";
import type { Config } from "./config";

export { Config } from "./config";

/** Provides `office_render` and `office_convert`. */
export function apply(ctx: PluginAPI, config?: Config): void {
	const maxChars = config?.maxChars ?? 120000;
	ctx.effect(activateCapability("tool", "office"), "tool-office:office");
	ctx.effect(
		registerToolProvider("office_render", session => new OfficeRenderTool(session, maxChars), {
			packageName: "musepi-tool-office",
		}),
		"tool-office:render",
	);
	ctx.effect(
		registerToolProvider("office_convert", session => new OfficeConvertTool(session, maxChars), {
			packageName: "musepi-tool-office",
		}),
		"tool-office:convert",
	);
}
