/** Reads, renders and converts Office documents (`office_render` / `office_convert` / `office_recalculate`). */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { OfficeConvertTool, OfficeRecalculateTool, OfficeRenderTool } from "@musepi/pi-coding-agent/tools/office";
import { setOfficeActivationSkills } from "@musepi/pi-coding-agent/tools/office-activation";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";
import type { Config } from "./config";

export { Config } from "./config";

/** Provides the Office tools; each is admitted after an Office skill loads. */
export function apply(ctx: PluginAPI, config?: Config): void {
	const maxChars = config?.maxChars ?? 120000;
	const maxImages = config?.maxImages ?? 20;
	const maxBytes = config?.maxBytes ?? 32 * 1024 * 1024;
	setOfficeActivationSkills(config?.activationSkills ?? []);
	ctx.effect(activateCapability("tool", "office"), "tool-office:office");
	ctx.effect(
		registerToolProvider("office_render", session => new OfficeRenderTool(session, maxImages, maxBytes), {
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
	ctx.effect(
		registerToolProvider("office_recalculate", session => new OfficeRecalculateTool(session), {
			packageName: "musepi-tool-office",
		}),
		"tool-office:recalculate",
	);
}
