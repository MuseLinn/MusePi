import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";

export default function gui(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("browser", "gui"), "browser-backend:gui");
}
