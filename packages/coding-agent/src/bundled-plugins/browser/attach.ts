import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function attach(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("browser", "attach"), "browser-backend:attach");
}
