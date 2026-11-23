import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";

export default function launch(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("browser", "launch"), "browser-backend:launch");
}
