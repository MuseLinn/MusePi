import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { NotifyUserTool } from "../../tools/notify-user";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The session package provides `notify_user`. */
export default function notify(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "notify"), "tools-session:notify");
	ctx.effect!(
		registerToolProvider("notify_user", session =>
			session.settings.get("notifyUser") ? new NotifyUserTool(session) : null,
		),
		"tools-session:provide:notify",
	);
}
