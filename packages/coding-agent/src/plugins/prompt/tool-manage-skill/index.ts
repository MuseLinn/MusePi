/** Author managed skills. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { ManageSkillTool } from "@musepi/pi-coding-agent/tools/manage-skill";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `manage_skill`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "manage"), "tool-manage-skill:manage");
	ctx.effect!(
		registerToolProvider("manage_skill", session => ManageSkillTool.createIf(session)),
		"tool-manage-skill:provide",
	);
}
