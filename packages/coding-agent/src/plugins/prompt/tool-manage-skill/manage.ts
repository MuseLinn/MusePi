import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { ManageSkillTool } from "../../../tools/manage-skill";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** Provides `manage_skill`. */
export default function manage(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "manage"), "tool-manage-skill:manage");
	ctx.effect!(
		registerToolProvider("manage_skill", session => ManageSkillTool.createIf(session)),
		"tool-manage-skill:provide",
	);
}
