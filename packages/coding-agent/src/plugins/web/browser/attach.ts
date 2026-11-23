import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export default function attach(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("browser", "attach"), "browser-backend:attach");
}
