import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { NotifyUserTool } from "../../tools/notify-user";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `notify_user`. */
export default function notify(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "notify"), "tool-notify-user:notify");
	ctx.effect!(
		registerToolProvider("notify_user", session => new NotifyUserTool(session)),
		"tool-notify-user:provide",
	);
}
