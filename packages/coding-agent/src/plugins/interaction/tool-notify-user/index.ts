/**
 * The `notify_user` tool as a capability package.
 *
 * The tool class lives in the host (`tools/notify-user.ts`) because the
 * built-in factory table needs it even when no package is mounted; this package
 * is what makes it a mounted capability — it owns the enable gate and supplies
 * the implementation once composed.
 */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { NotifyUserTool } from "@musepi/pi-coding-agent/tools/notify-user";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

export const name = "musepi-tool-notify-user";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "notify"), "tool-notify-user:notify");
	ctx.effect!(
		registerToolProvider("notify_user", session => new NotifyUserTool(session)),
		"tool-notify-user:provide",
	);
}
