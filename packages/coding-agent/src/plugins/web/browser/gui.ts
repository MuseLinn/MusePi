import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export default function gui(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("browser", "gui"), "browser-backend:gui");
}
