import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { ManageSkillTool } from "../../tools/manage-skill";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The skill package provides `manage_skill`. */
export default function manage(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "manage_skill"), "tools-skill:manage");
	ctx.effect!(
		registerToolProvider("manage_skill", session => ManageSkillTool.createIf(session)),
		"tools-skill:provide:manage",
	);
}
