import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";

export default function attach(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("browser", "attach"), "browser-backend:attach");
}
