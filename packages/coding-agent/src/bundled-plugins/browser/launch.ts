import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function launch(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("browser", "launch"), "browser-backend:launch");
}
